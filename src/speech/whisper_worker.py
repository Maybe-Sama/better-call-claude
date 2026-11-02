"""AgentCall local speech worker: faster-whisper on CPU, fully offline after the model download.

Same line protocol as the other engines (see stt-worker.ps1):
  stdout  {"type": "ready"|"listening"|"paused"|"partial"|"final"|"level"|"error", ...}  (ASCII JSON)
  stdin   "listen" | "pause"; EOF ends the worker.

Audio is segmented with an adaptive energy detector: while the user speaks, the growing utterance is
re-transcribed every PARTIAL_EVERY_S with a small fast model (live caption, ~0.5 s on CPU); after
END_SILENCE_S of silence it is transcribed with the accurate model and the Silero VAD filter and
emitted as "final". {"type":"speech","state":"start"|"end"} lets the app time "1.5 s after you stop".
Nothing is written to disk.
"""
import argparse
import base64
import json
import math
import os
import queue
import re
import sys
import threading
import time
import wave

import numpy as np

SAMPLE_RATE = 16000
FRAME = 480                      # 30 ms
PRE_ROLL_S = 0.6                 # keep the soft start of a phrase ("En-lace") that is below the threshold
START_FRAMES = 3                 # 3 of the last 5 frames must be speech to open an utterance
END_SILENCE_S = float(os.environ.get("AGENTCALL_END_SILENCE", "0.7"))  # silence that closes a phrase (→ final)
PARTIAL_EVERY_S = 0.8
# Speculative final: after this much silence the phrase is already transcribed with the final model.
# If the silence lasts until END_SILENCE_S that result is the final (it saves the transcription time);
# if the user goes on talking it is discarded.
SPECULATE_S = float(os.environ.get("AGENTCALL_SPECULATE", "0.25"))
MIN_UTTERANCE_S = 0.35
MAX_UTTERANCE_S = 25.0
# Close-talk gate: software gain applied to the microphone and the minimum level (RMS after gain) a
# frame needs to count as speech. Raise the threshold to ignore room noise and distant voices.
def _env_float(name, default, low, high):
    try:
        value = float(os.environ.get(name, default))
        return value if low <= value <= high else default
    except ValueError:
        return default


MIC_GAIN = _env_float("AGENTCALL_MIC_GAIN", 1.0, 0.05, 10.0)
SPEECH_THRESHOLD = _env_float("AGENTCALL_SPEECH_THRESHOLD", 0.006, 0.0, 0.5)

# Text Whisper is known to invent on silence/noise in Spanish.
HALLUCINATIONS = re.compile(
    r"amara\.org|subt[ií]tulos|suscr[ií]bete|gracias por ver|gracias por su atenci[oó]n|closed captioning|captioning by|"
    r"subtitles by|transcribed by|"
    r"m[aá]s informaci[oó]n en|www\.|^\W*$|^\W*gracias\W*$",
    re.IGNORECASE,
)

# The same word or short group 4+ times in a row is a decoding loop, not speech ("Haz Haz Haz…").
REPEATS = re.compile(r"\b(\w+(?:[\s,]+\w+){0,3}?)(?:[\s,.:;!?¡¿-]+\1\b){3,}", re.IGNORECASE)


def collapse_repeats(text):
    return REPEATS.sub(r"\1", text)


# Vocabulary only: Whisper copies prompt sentences into what it hears (live test 2026-11-02:
# "Déjalo Conversación con Claude Code.").
DEFAULT_PROMPT = (
    "Claude, Supabase, Vercel, Next.js, React, TypeScript, JavaScript, API, commit, deploy, merge, "
    "frontend, backend, endpoint, webhook, Postgres, SQLite, staging, pull request, base de datos."
)

out_lock = threading.Lock()
T0 = time.monotonic()


def emit(obj):
    # "wt": seconds since the worker started, so the voice lab can align events with a test WAV.
    obj.setdefault("wt", round(time.monotonic() - T0, 3))
    line = json.dumps(obj, ensure_ascii=True)
    with out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


class Transcriber(threading.Thread):
    """Runs Whisper off the audio thread. Partials are best-effort (only the newest is kept)."""

    def __init__(self, model, language, prompt, partial_model=None):
        super().__init__(daemon=True)
        self.model = model
        self.partial_model = partial_model or model
        self.language = language
        self.prompt = prompt
        self.cv = threading.Condition()
        self.finals = []
        self.partial = None
        self.done_utterances = set()
        self.stale_upto = 0  # utterances <= this id belong to a paused/ended listening period
        self.context = ""
        self.hotwords = None
        self.busy = False  # a transcription popped from the queue is running
        self.spec = {}     # utt_id → {"gen", "result", "promoted"} for speculative finals

    def set_context(self, text, hotwords):
        """What Claude just said / asked: biases Whisper towards the words the user is likely to use."""
        with self.cv:
            self.context = (text or "").strip()[:500]
            self.hotwords = (hotwords or "").strip()[:300] or None

    def current_prompt(self):
        return f"{self.prompt} {self.context}".strip() if self.context else self.prompt

    def invalidate(self, upto_utt_id):
        """Pause: drop queued work and suppress any in-flight result from before this point."""
        with self.cv:
            self.stale_upto = max(self.stale_upto, upto_utt_id)
            self.finals.clear()
            self.partial = None
            self.spec.clear()

    def speculate(self, utt_id, gen, audio):
        with self.cv:
            self.spec[utt_id] = {"gen": gen, "result": None, "promoted": False}
        self.submit("spec", utt_id, audio, gen)

    def discard_spec(self, utt_id):
        with self.cv:
            self.spec.pop(utt_id, None)

    def promote(self, utt_id, gen):
        """The phrase really ended: its speculative transcript becomes the final (now or when ready).
        False if there is no valid speculation (then a normal final is needed)."""
        with self.cv:
            entry = self.spec.get(utt_id)
            if not entry or entry["gen"] != gen:
                return False
            result = entry["result"]
            if result is None:
                entry["promoted"] = True
        if result is not None:
            self._emit_final(utt_id, *result, speculative=True)
        return True

    def _emit_final(self, utt_id, text, confidence, timing, speculative=False):
        with self.cv:
            if utt_id in self.done_utterances:
                return
            self.done_utterances.add(utt_id)
            self.spec.pop(utt_id, None)
        extra = {"speculative": True} if speculative else {}
        if text:
            emit({"type": "final", "text": text, "confidence": round(confidence, 3), "utterance": utt_id, **timing, **extra})
        else:
            emit({"type": "rejected", "utterance": utt_id, **timing, **extra})

    def _stale(self, utt_id):
        return utt_id <= self.stale_upto

    def submit(self, kind, utt_id, audio, gen=None):
        with self.cv:
            if self._stale(utt_id):
                return
            if kind in ("final", "spec"):
                self.finals.append((kind, utt_id, audio, gen))
                self.partial = None
            else:
                self.partial = (utt_id, audio)
            self.cv.notify()

    def run(self):
        while True:
            with self.cv:
                while not self.finals and self.partial is None:
                    self.cv.wait()
                if self.finals:
                    kind, utt_id, audio, gen = self.finals.pop(0)
                else:
                    (utt_id, audio), kind, gen = self.partial, "partial", None
                    self.partial = None
                self.busy = True
            try:
                self._process(kind, utt_id, audio, gen)
            finally:
                with self.cv:
                    self.busy = False

    def idle(self):
        with self.cv:
            return not self.finals and self.partial is None and not self.busy

    def _process(self, kind, utt_id, audio, gen=None):
        if self._stale(utt_id) or (kind == "partial" and utt_id in self.done_utterances):
            return
        if kind == "spec":
            with self.cv:
                entry = self.spec.get(utt_id)
            if not entry or entry["gen"] != gen:
                return  # the user went on talking: this speculation is obsolete
        started = time.monotonic()
        try:
            # A speculative final IS the final if the silence lasts: same model and settings.
            text, confidence = self.transcribe(audio, final=(kind in ("final", "spec")))
        except Exception as exc:  # keep the worker alive
            emit({"type": "error", "engine": "whisper", "message": str(exc)[:300]})
            if kind == "spec":
                with self.cv:
                    entry = self.spec.pop(utt_id, None)
                if entry and entry["gen"] == gen and entry["promoted"]:
                    self.submit("final", utt_id, audio)  # the phrase ended meanwhile: transcribe it normally
            return
        if self._stale(utt_id):
            return
        timing = {"stt_ms": int((time.monotonic() - started) * 1000), "audio_ms": int(len(audio) * 1000 / SAMPLE_RATE)}
        if kind == "spec":
            with self.cv:
                entry = self.spec.get(utt_id)
                if not entry or entry["gen"] != gen:
                    return
                entry["result"] = (text, confidence, timing)
                promoted = entry["promoted"]
            if promoted:
                self._emit_final(utt_id, text, confidence, timing, speculative=True)
        elif kind == "final":
            self._emit_final(utt_id, text, confidence, timing)
        elif text and utt_id not in self.done_utterances:
            emit({"type": "partial", "text": text, "utterance": utt_id, **timing})

    def transcribe(self, audio, final):
        model = self.model if final else self.partial_model
        segments, _info = model.transcribe(
            audio,
            language=self.language,
            beam_size=5 if final else 1,
            best_of=1,
            # Finals retry at higher temperature when the text looks like a loop (compression ratio).
            temperature=[0.0, 0.2, 0.4] if final else 0.0,
            compression_ratio_threshold=2.4,
            condition_on_previous_text=False,
            initial_prompt=self.current_prompt(),
            hotwords=self.hotwords,
            without_timestamps=True,
            vad_filter=final,
            no_speech_threshold=0.6,
        )
        texts, logprobs = [], []
        for seg in segments:
            if seg.no_speech_prob > 0.6 and seg.avg_logprob < -0.8:
                continue
            t = collapse_repeats(seg.text.strip())
            if not t or HALLUCINATIONS.search(t):
                continue
            texts.append(t)
            logprobs.append(seg.avg_logprob)
        if not texts:
            return "", 0.0
        confidence = math.exp(sum(logprobs) / len(logprobs))
        return " ".join(texts).strip(), confidence


class Segmenter:
    """Adaptive energy voice-activity detector working in audio time."""

    def __init__(self, transcriber):
        self.t = transcriber
        self.noise = 0.004
        self.history = []
        self.pre_roll = []
        self.utterance = None
        self.utt_id = 0
        self.silent_frames = 0
        self.since_partial = 0
        self.last_level = 0.0
        self.frames_fed = 0  # audio clock: position of the current frame in the stream
        self.spec_gen = 0    # speculative final of the current phrase (see SPECULATE_S)
        self.spec_live = False
        self.context_schedule = []  # voice lab: [(audio_t, text, hotwords)] applied as the WAV plays

    def cancel(self):
        """Pause: abandon the current utterance (telling the app speech ended) and all pending work."""
        if self.utterance is not None:
            emit({"type": "speech", "state": "end", "utterance": self.utt_id, "cancelled": True})
        self.t.invalidate(self.utt_id)
        self.reset()

    def reset(self):
        self.utterance = None
        self.spec_live = False
        self.history = []
        self.pre_roll = []
        self.silent_frames = 0

    def audio_t(self):
        return round(self.frames_fed * FRAME / SAMPLE_RATE, 3)

    def feed(self, frame):
        self.frames_fed += 1
        rms = float(np.sqrt(np.mean(frame * frame)) + 1e-9)
        threshold = max(self.noise * 2.2, SPEECH_THRESHOLD)
        self.last_threshold = threshold
        speech = rms > threshold
        now = time.monotonic()
        if now - self.last_level > 0.12:
            self.last_level = now
            emit({"type": "level", "value": int(min(100, rms * 600))})

        if self.utterance is None:
            if not speech:
                self.noise = 0.97 * self.noise + 0.03 * rms
            self.history = (self.history + [speech])[-5:]
            self.pre_roll = (self.pre_roll + [frame])[-int(PRE_ROLL_S * SAMPLE_RATE / FRAME):]
            if self.context_schedule and self.audio_t() >= self.context_schedule[0][0]:
                _at, text, hotwords = self.context_schedule.pop(0)
                self.t.set_context(text, hotwords)
            if sum(self.history) >= START_FRAMES:
                self.utt_id += 1
                # onset_ms: how long ago (audio time) the first speech frame of the window was heard.
                onset_ms = (len(self.history) - self.history.index(True)) * FRAME * 1000 // SAMPLE_RATE
                emit({"type": "speech", "state": "start", "utterance": self.utt_id, "onset_ms": onset_ms, "audio_t": self.audio_t()})
                self.utterance = list(self.pre_roll)
                self.levels = []
                self.silent_frames = 0
                self.since_partial = 0
            return

        self.utterance.append(frame)
        if speech:
            self.levels.append(rms)
            if self.spec_live:  # the pause was only a pause
                self.t.discard_spec(self.utt_id)
                self.spec_live = False
        self.silent_frames = 0 if speech else self.silent_frames + 1
        self.since_partial += 1
        length_s = len(self.utterance) * FRAME / SAMPLE_RATE
        silence_s = self.silent_frames * FRAME / SAMPLE_RATE
        if silence_s >= END_SILENCE_S or length_s >= MAX_UTTERANCE_S:
            self.finish()
        elif (not speech and not self.spec_live and SPECULATE_S < END_SILENCE_S and silence_s >= SPECULATE_S
              and length_s - silence_s >= MIN_UTTERANCE_S):
            self.spec_gen += 1
            self.spec_live = True
            self.t.speculate(self.utt_id, self.spec_gen, np.concatenate(self.utterance))
        elif self.since_partial * FRAME / SAMPLE_RATE >= PARTIAL_EVERY_S and length_s >= 0.6:
            self.since_partial = 0
            self.t.submit("partial", self.utt_id, np.concatenate(self.utterance))

    def finish(self):
        if self.utterance is None:
            return
        audio = np.concatenate(self.utterance)
        voiced_s = len(audio) / SAMPLE_RATE - self.silent_frames * FRAME / SAMPLE_RATE
        levels = getattr(self, "levels", []) or [0.0]
        emit({"type": "speech", "state": "end", "utterance": self.utt_id, "peak": round(max(levels), 4),
              "rms": round(sum(levels) / len(levels), 4), "threshold": round(getattr(self, "last_threshold", 0.0), 4),
              "silence_ms": self.silent_frames * FRAME * 1000 // SAMPLE_RATE, "voiced_ms": int(voiced_s * 1000), "audio_t": self.audio_t()})
        if voiced_s >= MIN_UTTERANCE_S:
            if not (self.spec_live and self.t.promote(self.utt_id, self.spec_gen)):
                self.t.submit("final", self.utt_id, audio)
        elif self.spec_live:
            self.t.discard_spec(self.utt_id)
        self.spec_live = False
        self.reset()


def load_model(args, name=None):
    if args.backend == "dml":
        # GPU through DirectML (AMD/Intel/NVIDIA): large-v3-turbo, fast enough for partials and finals.
        from whisper_dml import DmlWhisper
        return DmlWhisper(args.dml_model_dir)
    from faster_whisper import WhisperModel
    threads = args.threads or max(2, min(8, (os.cpu_count() or 4) // 2))
    return WhisperModel(name or args.model, device="cpu", compute_type="int8", cpu_threads=threads,
                        download_root=args.models_dir or None)


def run_wav(args, segmenter):
    with wave.open(args.wav, "rb") as w:
        if w.getframerate() != SAMPLE_RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit("test WAV must be 16 kHz mono 16-bit")
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    pcm = np.concatenate([pcm, np.zeros(SAMPLE_RATE, dtype=np.float32)])  # trailing silence
    # --realtime paces the frames like a microphone, so latencies measured on the WAV are real ones.
    emit({"type": "wav-start", "seconds": round(len(pcm) / SAMPLE_RATE, 2), "realtime": bool(args.realtime)})
    started = time.monotonic()
    for n, i in enumerate(range(0, len(pcm) - FRAME, FRAME)):
        if args.realtime:
            delay = started + n * FRAME / SAMPLE_RATE - time.monotonic()
            if delay > 0:
                time.sleep(delay)
        segmenter.feed(pcm[i:i + FRAME])
    segmenter.finish()
    while not segmenter.t.idle():  # queued work and the transcription in progress
        time.sleep(0.1)
    time.sleep(0.5)
    emit({"type": "wav-end"})


def pick_input_device(sd, wanted):
    """AGENTCALL_MIC / --mic: part of the microphone name (e.g. "BEHRINGER" or "IN 1"). Prefers WASAPI."""
    if not wanted:
        return None
    wanted = wanted.lower()
    matches = [(i, d) for i, d in enumerate(sd.query_devices())
               if d["max_input_channels"] > 0 and wanted in d["name"].lower()]
    if not matches:
        emit({"type": "error", "engine": "whisper", "message": f"No encuentro el micrófono '{wanted}'; uso el predeterminado."})
        return None
    wasapi = [i for i, d in matches if "WASAPI" in sd.query_hostapis(d["hostapi"])["name"]]
    return wasapi[0] if wasapi else matches[0][0]


def run_mic(segmenter, mic="", source="device"):
    """source "device": the microphone through sounddevice (no echo cancellation).
    source "stdin": 16 kHz mono int16 PCM sent by AgentCall as {"pcm": base64} lines — captured by
    Electron with Chromium's echo cancellation, so Claude's own voice is removed before Whisper hears it."""
    frames = queue.Queue()
    listening = threading.Event()
    stop = threading.Event()

    def reader():
        for line in iter(sys.stdin.readline, ""):
            if line.lstrip().startswith("{"):
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if "pcm" in msg:
                    if listening.is_set():
                        try:
                            pcm = np.frombuffer(base64.b64decode(msg["pcm"]), dtype="<i2").astype(np.float32) / 32768.0
                            frames.put(pcm)
                        except (ValueError, TypeError):
                            pass
                elif msg.get("cmd") == "context":
                    segmenter.t.set_context(msg.get("text", ""), msg.get("hotwords", ""))
                continue
            cmd = line.strip().lower()
            if cmd == "listen" and not listening.is_set():
                listening.set()
                emit({"type": "listening"})
            elif cmd == "pause" and listening.is_set():
                listening.clear()
                emit({"type": "paused"})
        stop.set()

    threading.Thread(target=reader, daemon=True).start()

    if source == "stdin":
        emit({"type": "mic", "name": "AgentCall (cancelación de eco)"})
        consume(segmenter, frames, listening, stop, SAMPLE_RATE)
        return

    import sounddevice as sd

    device = pick_input_device(sd, mic)
    if device is not None:
        emit({"type": "mic", "name": sd.query_devices(device)["name"]})
    device_rate = SAMPLE_RATE
    try:
        sd.check_input_settings(device=device, samplerate=SAMPLE_RATE, channels=1, dtype="float32")
    except Exception:
        device_rate = int(sd.query_devices(device if device is not None else sd.default.device[0])["default_samplerate"])

    def callback(indata, _frames, _time, _status):
        if listening.is_set():
            frames.put(indata[:, 0].copy())

    block = int(device_rate * FRAME / SAMPLE_RATE)
    with sd.InputStream(device=device, samplerate=device_rate, channels=1, dtype="float32", blocksize=block, callback=callback):
        consume(segmenter, frames, listening, stop, device_rate)


def consume(segmenter, frames, listening, stop, device_rate):
    """Feeds captured audio to the segmenter in 30 ms frames until stdin closes."""
    pending = np.zeros(0, dtype=np.float32)
    was_listening = False
    while not stop.is_set():
        if was_listening and not listening.is_set():
            segmenter.cancel()  # paused: drop the utterance and anything still being transcribed
            pending = np.zeros(0, dtype=np.float32)
            while not frames.empty():  # audio captured just before the pause belongs to no one
                try:
                    frames.get_nowait()
                except queue.Empty:
                    break
        was_listening = listening.is_set()
        try:
            chunk = frames.get(timeout=0.2)
        except queue.Empty:
            continue
        if not listening.is_set():
            continue
        if device_rate != SAMPLE_RATE:
            n = int(round(len(chunk) * SAMPLE_RATE / device_rate))
            chunk = np.interp(np.linspace(0, len(chunk) - 1, n), np.arange(len(chunk)), chunk).astype(np.float32)
        if MIC_GAIN != 1.0:
            chunk = chunk * MIC_GAIN
        pending = np.concatenate([pending, chunk])
        while len(pending) >= FRAME:
            segmenter.feed(pending[:FRAME])
            pending = pending[FRAME:]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.environ.get("AGENTCALL_WHISPER_MODEL", "small"))
    parser.add_argument("--partial-model", default=os.environ.get("AGENTCALL_WHISPER_PARTIAL_MODEL", "base"))
    parser.add_argument("--language", default="es")
    parser.add_argument("--models-dir", default="")
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT + (" " + os.environ["AGENTCALL_STT_VOCAB"] if os.environ.get("AGENTCALL_STT_VOCAB") else ""))
    parser.add_argument("--backend", default=os.environ.get("AGENTCALL_WHISPER_BACKEND", "cpu"), choices=["cpu", "dml"])
    parser.add_argument("--dml-model-dir", default=os.path.join(os.environ.get("LOCALAPPDATA", "."), "AgentCall", "models", "whisper-turbo-onnx"))
    parser.add_argument("--wav", default="")
    parser.add_argument("--realtime", action="store_true", help="testing: feed --wav at real-time speed")
    parser.add_argument("--context-file", default="", help="testing: JSON [{at, text, hotwords}] applied while the WAV plays")
    parser.add_argument("--mic", default=os.environ.get("AGENTCALL_MIC", ""))
    parser.add_argument("--source", default="device", choices=["device", "stdin"])
    parser.add_argument("--context", default="", help="testing: context text")
    parser.add_argument("--hotwords", default="", help="testing: hotwords")
    args = parser.parse_args()

    try:
        started = time.monotonic()
        model = load_model(args)
        partial_model = None
        if args.backend != "dml" and args.partial_model and args.partial_model != args.model:
            try:
                partial_model = load_model(args, args.partial_model)
            except Exception:
                partial_model = None  # live captions fall back to the main model
    except Exception as exc:
        emit({"type": "error", "engine": "whisper", "fatal": True, "message": f"No se pudo cargar Whisper: {exc}"[:400],
              "hint": "Ejecuta scripts/setup-whisper.ps1 o usa el campo de texto."})
        return 2

    transcriber = Transcriber(model, args.language, args.prompt, partial_model)
    transcriber.start()
    segmenter = Segmenter(transcriber)
    if args.context or args.hotwords:
        transcriber.set_context(args.context, args.hotwords)
    if args.context_file:
        with open(args.context_file, encoding="utf-8") as f:
            segmenter.context_schedule = sorted((c["at"], c.get("text", ""), c.get("hotwords", "")) for c in json.load(f))
    label = "large-v3-turbo (local, GPU DirectML)" if args.backend == "dml" else f"{args.model} (local, CPU)"
    emit({"type": "ready", "engine": "whisper", "recognizer": f"Whisper {label}",
          "loadSeconds": round(time.monotonic() - started, 1)})
    try:
        if args.wav:
            run_wav(args, segmenter)
        else:
            run_mic(segmenter, args.mic, args.source)
    except Exception as exc:
        emit({"type": "error", "engine": "whisper", "fatal": True, "message": f"Micrófono: {exc}"[:400],
              "hint": "Comprueba el micrófono predeterminado de Windows o usa el campo de texto."})
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
