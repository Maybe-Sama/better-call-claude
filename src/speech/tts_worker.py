"""AgentCall voice: Kokoro-82M (ONNX) on CPU, fully local. Persistent worker with the model loaded.

stdin  (one JSON object per line)
  {"cmd": "speak", "id": "...", "text": "..."}   replaces whatever is being said
  {"cmd": "ack", "id": "..."}                     short pre-rendered acknowledgement ("Vale, se lo paso a Claude.")
  {"cmd": "stop"}                                  silence now (the user started talking)
stdout (ASCII JSON lines)
  {"type": "ready"}  {"type": "audio", "id", "seq", "rate", "pcm": base64 int16 mono}  {"type": "done", "id"}  {"type": "error"}

Text is synthesised sentence by sentence and each sentence is streamed as soon as it is ready, so
AgentCall starts playing after the first one while the next is generated. AgentCall plays the audio in
its own window (same device as the ringtone) and can cut it instantly. Nothing is written to disk.
"""
import argparse
import base64
import json
import os
import queue
import random
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


ACKS = [
    "Vale, se lo paso a Claude.",
    "Entendido, se lo digo.",
    "Perfecto, se lo paso.",
]


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
        self.current = None
        self.acks = []

    def synth(self, text):
        samples, sr = self.k.create(text, voice=self.voice, speed=self.speed, lang=self.lang)
        samples = np.asarray(samples, dtype=np.float32)
        if sr != self.SAMPLE_RATE:
            n = int(round(len(samples) * self.SAMPLE_RATE / sr))
            samples = np.interp(np.linspace(0, len(samples) - 1, n), np.arange(len(samples)), samples).astype(np.float32)
        return samples

    def prerender_acks(self):
        for text in ACKS:
            audio = None
            if self.edge_voice:
                try:
                    audio = ("mp3", self.edge_mp3(text))
                except Exception:
                    audio = None
            self.acks.append((text, audio or ("pcm", self.synth(text))))

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

    def stop(self):
        with self.lock:
            cur, self.current = self.current, None
        if cur:
            cur.set()

    def speak(self, utt_id, text=None, audio=None):
        self.stop()
        cur = threading.Event()
        with self.lock:
            self.current = cur
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
            if audio is not None:
                self._send(utt_id, seq, audio[1], audio[0])
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
            speaker.speak(msg.get("id", "ack"), audio=random.choice(speaker.acks))
        elif cmd == "stop":
            speaker.stop()
    speaker.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
