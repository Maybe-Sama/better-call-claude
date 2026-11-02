"""AgentCall voice: Kokoro-82M (ONNX) on CPU, fully local. Persistent worker with the model loaded.

stdin  (one JSON object per line)
  {"cmd": "speak", "id": "...", "text": "..."}   replaces whatever is being said
  {"cmd": "ack", "id": "...", "phrase": "vale"}  short pre-rendered acknowledgement (vale | entendido | momento)
  {"cmd": "stop"}                                  silence now (the user started talking)
  {"cmd": "prepare", "text": "..."}               synthesise ahead (while the phone rings); a later speak of
                                                   the same text plays from this cache at once
  {"cmd": "stream-start", "id": "..."}            Claude's answer is being written: sentences follow
  {"cmd": "stream-append", "id": "...", "text"}   one more speakable sentence (synthesis starts at once)
  {"cmd": "stream-end", "id": "..."}              no more sentences; "done" once the last one is sent
stdout (ASCII JSON lines)
  {"type": "ready"}  {"type": "audio", "id", "seq", "rate", "pcm": base64 int16 mono}  {"type": "done", "id"}  {"type": "error"}

Text is synthesised sentence by sentence and each sentence is streamed as soon as it is ready, so
AgentCall starts playing after the first one while the next is generated. AgentCall plays the audio in
its own window (same device as the ringtone) and can cut it instantly. Nothing is written to disk.
"""
import argparse
import base64
import collections
import concurrent.futures
import json
import os
import queue
import re
import sys
import threading

import numpy as np

out_lock = threading.Lock()


def emit(obj):
    line = json.dumps(obj, ensure_ascii=True)
    with out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


# Short on purpose: they only cover the wait before Claude answers (VoiceConversation picks one).
ACKS = {
    "vale": "Vale.",
    "entendido": "Entendido.",
    "momento": "Un momento.",
}


def normalize(text):
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"(\d+)\s?s\b", r"\1 segundos", text)
    text = re.sub(r"(\d+)\s?min\b", r"\1 minutos", text)
    text = text.replace("«", "").replace("»", "").replace("…", "...")
    return text


def sentences(text, max_len=220):
    parts = re.split(r"(?<=[.!?…:;])\s+", normalize(text))
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        while len(p) > max_len:  # very long sentence: cut at a comma near the limit
            cut = p.rfind(", ", 0, max_len)
            cut = cut if cut > 40 else max_len
            out.append(p[:cut + 1].strip())
            p = p[cut + 1:].strip()
        if out and len(out[-1]) < 25:
            out[-1] = f"{out[-1]} {p}"  # merge tiny fragments ("Vale.") with the next sentence
        else:
            out.append(p)
    return out


class Prepared:
    """Audio synthesised ahead of time for one text; filled sentence by sentence."""

    def __init__(self):
        self.items = []
        self.done = False
        self.failed = False  # stopped before the last sentence: the rest is synthesised when spoken
        self.cv = threading.Condition()


class Speaker:
    """Synthesises sentence by sentence and streams PCM to AgentCall, which plays it in its window
    (same output device as the ringtone). Stopping just abandons the remaining sentences."""

    SAMPLE_RATE = 24000

    def __init__(self, kokoro, voice, speed, lang, edge_voice=None, edge_rate="+0%"):
        self.k = kokoro
        self.edge_voice = edge_voice  # Microsoft Edge neural voice (online); Kokoro is the offline fallback
        self.edge_rate = edge_rate
        self.voice = voice
        self.speed = speed
        self.lang = lang
        self.lock = threading.Lock()
        self.model_lock = threading.Lock()
        self.current = None
        self.current_id = None  # id of the utterance being produced (speak, ack or stream)
        self.acks = {}
        self.prepared = collections.OrderedDict()  # normalized text → Prepared (a few, newest last)
        self.stream = None  # {"id", "queue", "stopped"} while Claude's answer is streamed in
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)  # sentences rendered ahead, in order

    def synth(self, text):
        with self.model_lock:  # an interrupted utterance may still be inside create(); never run two at once
            samples, sr = self.k.create(text, voice=self.voice, speed=self.speed, lang=self.lang)
        samples = np.asarray(samples, dtype=np.float32)
        if sr != self.SAMPLE_RATE:
            n = int(round(len(samples) * self.SAMPLE_RATE / sr))
            samples = np.interp(np.linspace(0, len(samples) - 1, n), np.arange(len(samples)), samples).astype(np.float32)
        return samples

    def prerender_acks(self):
        for key, text in ACKS.items():
            audio = None
            if self.edge_voice:
                try:
                    audio = ("mp3", self.edge_mp3(text))
                except Exception:
                    audio = None
            self.acks[key] = (text, audio or ("pcm", self.synth(text)))

    def edge_mp3(self, text):
        import asyncio
        return asyncio.run(self._edge_mp3(text))

    async def _edge_mp3(self, text):
        import edge_tts

        data = bytearray()
        async for chunk in edge_tts.Communicate(text, self.edge_voice, rate=self.edge_rate).stream():
            if chunk["type"] == "audio":
                data.extend(chunk["data"])
        if not data:
            raise RuntimeError("Edge TTS returned no audio")
        return bytes(data)

    def prepare(self, text):
        key = normalize(text)
        if not key or key in self.prepared:
            return
        entry = Prepared()
        self.prepared[key] = entry
        while len(self.prepared) > 4:
            self.prepared.popitem(last=False)
        threading.Thread(target=self._fill, args=(key, entry), daemon=True).start()

    def _fill(self, text, entry):
        try:
            parts = sentences(text)
            produced = (self._edge_sentences(parts, threading.Event()) if self.edge_voice
                        else ((s, ("pcm", self.synth(s))) for s in parts))
            for s, audio in produced:
                with entry.cv:
                    entry.items.append((s, audio))
                    entry.cv.notify_all()
        except Exception as exc:
            emit({"type": "warning", "message": f"prepare: {exc}"[:200]})
            entry.failed = True
            if self.prepared.get(text) is entry:
                self.prepared.pop(text, None)  # never serve a cut-down version again
        finally:
            with entry.cv:
                entry.done = True
                entry.cv.notify_all()

    def _play_prepared(self, utt_id, stopped, entry):
        seq = 0
        while not stopped.is_set():
            with entry.cv:
                while seq >= len(entry.items) and not entry.done and not stopped.is_set():
                    entry.cv.wait(0.05)
                if seq >= len(entry.items):
                    break
                s, audio = entry.items[seq]
            self._send(utt_id, seq, audio, s)
            seq += 1
        return seq

    # ── Streamed answers: sentences arrive while Claude writes ───────────────
    def render(self, text):
        if self.edge_voice:
            try:
                import asyncio
                return ("mp3", asyncio.run(asyncio.wait_for(self._edge_mp3(text), timeout=8)))
            except Exception as exc:
                emit({"type": "warning", "message": f"Edge TTS: {exc}"[:200]})
        return ("pcm", self.synth(text))

    def stream_start(self, utt_id):
        self.stop()
        stopped = threading.Event()
        st = {"id": utt_id, "queue": queue.Queue(), "stopped": stopped}
        with self.lock:
            self.current = stopped
            self.current_id = utt_id
            self.stream = st
        threading.Thread(target=self._produce_stream, args=(st,), daemon=True).start()

    def stream_append(self, utt_id, text):
        st = self.stream
        if not st or st["id"] != utt_id or st["stopped"].is_set():
            return
        for s in sentences(text):
            st["queue"].put((s, self.pool.submit(self.render, s)))

    def stream_end(self, utt_id):
        st = self.stream
        if st and st["id"] == utt_id:
            st["queue"].put(None)

    def _produce_stream(self, st):
        seq = 0
        try:
            while not st["stopped"].is_set():
                try:
                    item = st["queue"].get(timeout=0.2)
                except queue.Empty:
                    continue
                if item is None:
                    break
                text, future = item
                audio = future.result()
                if st["stopped"].is_set():
                    break
                self._send(st["id"], seq, audio, text)
                seq += 1
        except Exception as exc:
            emit({"type": "error", "id": st["id"], "message": str(exc)[:300]})
        finally:
            emit({"type": "done", "id": st["id"], "chunks": seq, "interrupted": st["stopped"].is_set()})

    def stop(self, utt_id=None):
        # A stop that names an utterance only stops that one: one sent by the window can arrive after
        # the main process already started the next answer, and must not cut it.
        with self.lock:
            if utt_id and self.current_id and utt_id != self.current_id:
                return
            cur, self.current = self.current, None
            self.current_id = None
            self.stream = None
        if cur:
            cur.set()

    def speak(self, utt_id, text=None, audio=None):
        self.stop()
        cur = threading.Event()
        with self.lock:
            self.current = cur
            self.current_id = utt_id
        threading.Thread(target=self._produce, args=(utt_id, cur, text, audio), daemon=True).start()

    def _send(self, utt_id, seq, audio, text):
        kind, payload = audio
        if kind == "mp3":
            emit({"type": "audio", "id": utt_id, "seq": seq, "format": "mp3", "text": text,
                  "data": base64.b64encode(payload).decode("ascii")})
            return
        pcm = (np.clip(payload, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        emit({"type": "audio", "id": utt_id, "seq": seq, "format": "pcm16", "rate": self.SAMPLE_RATE, "text": text,
              "pcm": base64.b64encode(pcm).decode("ascii")})

    def _edge_sentences(self, parts, stopped):
        """Requests all sentences to Edge concurrently (max 3 in flight) and yields them in order;
        a sentence Edge cannot deliver is rendered with Kokoro instead."""
        import asyncio

        async def run():
            sem = asyncio.Semaphore(3)

            async def one(text):
                async with sem:
                    if stopped.is_set():
                        return None
                    try:
                        return ("mp3", await asyncio.wait_for(self._edge_mp3(text), timeout=8))
                    except Exception as exc:
                        emit({"type": "warning", "message": f"Edge TTS: {exc}"[:200]})
                        return None

            tasks = [asyncio.create_task(one(p)) for p in parts]
            results = []
            for text, task in zip(parts, tasks):
                audio = await task
                if stopped.is_set():
                    for t in tasks:
                        t.cancel()
                    break
                results.append((text, audio))
                yield_queue.put((text, audio))
            yield_queue.put(None)

        import queue as _q
        yield_queue = _q.Queue()
        threading.Thread(target=lambda: asyncio.run(run()), daemon=True).start()
        while True:
            item = yield_queue.get()
            if item is None:
                return
            text, audio = item
            yield text, audio or ("pcm", self.synth(text))

    def _produce(self, utt_id, stopped, text, audio):
        seq = 0
        try:
            entry = self.prepared.get(normalize(text)) if text else None
            if audio is not None:
                self._send(utt_id, seq, audio[1], audio[0])
                seq += 1
            elif entry is not None:
                seq = self._play_prepared(utt_id, stopped, entry)
                if entry.failed and not stopped.is_set():
                    for s in sentences(text)[seq:]:  # what preparation did not reach
                        if stopped.is_set():
                            break
                        self._send(utt_id, seq, self.render(s), s)
                        seq += 1
            elif self.edge_voice:
                for s, rendered in self._edge_sentences(sentences(text), stopped):
                    if stopped.is_set():
                        break
                    self._send(utt_id, seq, rendered, s)
                    seq += 1
            else:
                for s in sentences(text):
                    if stopped.is_set():
                        break
                    samples = self.synth(s)
                    if stopped.is_set():
                        break
                    self._send(utt_id, seq, ("pcm", samples), s)
                    seq += 1
        except Exception as exc:
            emit({"type": "error", "id": utt_id, "message": str(exc)[:300]})
        finally:
            emit({"type": "done", "id": utt_id, "chunks": seq, "interrupted": stopped.is_set()})


def main():
    parser = argparse.ArgumentParser()
    default_dir = os.path.join(os.environ.get("LOCALAPPDATA", "."), "AgentCall", "models", "kokoro")
    parser.add_argument("--models-dir", default=default_dir)
    parser.add_argument("--voice", default=os.environ.get("AGENTCALL_TTS_VOICE", "ef_dora"))
    parser.add_argument("--speed", type=float, default=float(os.environ.get("AGENTCALL_TTS_SPEED", "1.05")))
    parser.add_argument("--lang", default="es")
    parser.add_argument("--provider", default=os.environ.get("AGENTCALL_TTS_PROVIDER", "kokoro"), choices=["kokoro", "edge"])
    parser.add_argument("--edge-voice", default=os.environ.get("AGENTCALL_EDGE_VOICE", "es-ES-AlvaroNeural"))
    parser.add_argument("--edge-rate", default=os.environ.get("AGENTCALL_EDGE_RATE", "+5%"))
    args = parser.parse_args()

    try:
        from kokoro_onnx import Kokoro
        kokoro = Kokoro(os.path.join(args.models_dir, "kokoro-v1.0.onnx"), os.path.join(args.models_dir, "voices-v1.0.bin"))
        speaker = Speaker(kokoro, args.voice, args.speed, args.lang,
                          edge_voice=args.edge_voice if args.provider == "edge" else None, edge_rate=args.edge_rate)
        speaker.prerender_acks()  # also warms the model up
    except Exception as exc:
        emit({"type": "error", "fatal": True, "message": f"No se pudo cargar Kokoro: {exc}"[:400]})
        return 2

    emit({"type": "ready", "engine": args.provider, "voice": args.edge_voice if args.provider == "edge" else args.voice})
    for line in iter(sys.stdin.readline, ""):
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        cmd = msg.get("cmd")
        if cmd == "speak" and msg.get("text"):
            speaker.speak(msg.get("id", ""), text=msg["text"])
        elif cmd == "ack" and speaker.acks:
            ack = speaker.acks.get(msg.get("phrase")) or speaker.acks["vale"]
            speaker.speak(msg.get("id", "ack"), audio=ack)
        elif cmd == "stop":
            speaker.stop(msg.get("id"))
        elif cmd == "prepare" and msg.get("text"):
            speaker.prepare(msg["text"])
        elif cmd == "stream-start":
            speaker.stream_start(msg.get("id", ""))
        elif cmd == "stream-append" and msg.get("text"):
            speaker.stream_append(msg.get("id", ""), msg["text"])
        elif cmd == "stream-end":
            speaker.stream_end(msg.get("id", ""))
    speaker.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
