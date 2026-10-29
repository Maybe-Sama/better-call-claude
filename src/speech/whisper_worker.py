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
END_SILENCE_S = 0.7
PARTIAL_EVERY_S = 0.8
MIN_UTTERANCE_S = 0.35
MAX_UTTERANCE_S = 25.0
# Close-talk gate: software gain applied to the microphone and the minimum level (RMS after gain) a
# frame needs to count as speech. Raise the threshold to ignore room noise and distant voices.
MIC_GAIN = float(os.environ.get("AGENTCALL_MIC_GAIN", "1.0"))
SPEECH_THRESHOLD = float(os.environ.get("AGENTCALL_SPEECH_THRESHOLD", "0.006"))

# Text Whisper is known to invent on silence/noise in Spanish.
HALLUCINATIONS = re.compile(
    r"amara\.org|subt[ií]tulos|suscr[ií]bete|gracias por ver|gracias por su atenci[oó]n|"
    r"m[aá]s informaci[oó]n en|www\.|^\W*$",
    re.IGNORECASE,
)

DEFAULT_PROMPT = (
    "Conversación con Claude Code sobre un proyecto de software. "
    "Términos: Claude, Supabase, Vercel, Next.js, React, TypeScript, JavaScript, API, commit, deploy, "
    "frontend, backend, endpoint, base de datos."
)

out_lock = threading.Lock()


def emit(obj):
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

    def _stale(self, utt_id):
        return utt_id <= self.stale_upto

    def submit(self, kind, utt_id, audio):
        with self.cv:
            if self._stale(utt_id):
                return
            if kind == "final":
                self.finals.append((utt_id, audio))
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
                    kind, (utt_id, audio) = "final", self.finals.pop(0)
                else:
                    kind, (utt_id, audio) = "partial", self.partial
                    self.partial = None
            if self._stale(utt_id) or (kind == "partial" and utt_id in self.done_utterances):
                continue
            try:
                text, confidence = self.transcribe(audio, final=(kind == "final"))
            except Exception as exc:  # keep the worker alive
                emit({"type": "error", "engine": "whisper", "message": str(exc)[:300]})
                continue
            if self._stale(utt_id):
                continue
            if kind == "final":
                self.done_utterances.add(utt_id)
                if text:
                    emit({"type": "final", "text": text, "confidence": round(confidence, 3), "utterance": utt_id})
                else:
                    emit({"type": "rejected", "utterance": utt_id})
            elif text and utt_id not in self.done_utterances:
                emit({"type": "partial", "text": text, "utterance": utt_id})

    def transcribe(self, audio, final):
        model = self.model if final else self.partial_model
        segments, _info = model.transcribe(
            audio,
            language=self.language,
            beam_size=5 if final else 1,
            best_of=1,
            temperature=0.0,
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
            t = seg.text.strip()
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

    def cancel(self):
        """Pause: abandon the current utterance (telling the app speech ended) and all pending work."""
        if self.utterance is not None:
            emit({"type": "speech", "state": "end", "utterance": self.utt_id, "cancelled": True})
        self.t.invalidate(self.utt_id)
        self.reset()

    def reset(self):
        self.utterance = None
        self.history = []
        self.pre_roll = []
        self.silent_frames = 0

    def feed(self, frame):
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
            if sum(self.history) >= START_FRAMES:
                self.utt_id += 1
                emit({"type": "speech", "state": "start", "utterance": self.utt_id})
                self.utterance = list(self.pre_roll)
                self.levels = []
                self.silent_frames = 0
                self.since_partial = 0
            return

        self.utterance.append(frame)
        if speech:
            self.levels.append(rms)
        self.silent_frames = 0 if speech else self.silent_frames + 1
        self.since_partial += 1
        length_s = len(self.utterance) * FRAME / SAMPLE_RATE
        if self.silent_frames * FRAME / SAMPLE_RATE >= END_SILENCE_S or length_s >= MAX_UTTERANCE_S:
            self.finish()
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
              "rms": round(sum(levels) / len(levels), 4), "threshold": round(getattr(self, "last_threshold", 0.0), 4)})
        if voiced_s >= MIN_UTTERANCE_S:
            self.t.submit("final", self.utt_id, audio)
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
    for i in range(0, len(pcm) - FRAME, FRAME):
        segmenter.feed(pcm[i:i + FRAME])
    segmenter.finish()
    while segmenter.t.finals or segmenter.t.partial is not None:
        time.sleep(0.1)
    time.sleep(3)


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


def run_mic(segmenter, mic=""):
    import sounddevice as sd

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
                if msg.get("cmd") == "context":
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
    pending = np.zeros(0, dtype=np.float32)
    was_listening = False
    with sd.InputStream(device=device, samplerate=device_rate, channels=1, dtype="float32", blocksize=block, callback=callback):
        while not stop.is_set():
            if was_listening and not listening.is_set():
                segmenter.cancel()  # paused: drop the utterance and anything still being transcribed
                pending = np.zeros(0, dtype=np.float32)
            was_listening = listening.is_set()
            try:
                chunk = frames.get(timeout=0.2)
            except queue.Empty:
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
    parser.add_argument("--mic", default=os.environ.get("AGENTCALL_MIC", ""))
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
    label = "large-v3-turbo (local, GPU DirectML)" if args.backend == "dml" else f"{args.model} (local, CPU)"
    emit({"type": "ready", "engine": "whisper", "recognizer": f"Whisper {label}",
          "loadSeconds": round(time.monotonic() - started, 1)})
    try:
        if args.wav:
            run_wav(args, segmenter)
        else:
            run_mic(segmenter, args.mic)
    except Exception as exc:
        emit({"type": "error", "engine": "whisper", "fatal": True, "message": f"Micrófono: {exc}"[:400],
              "hint": "Comprueba el micrófono predeterminado de Windows o usa el campo de texto."})
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
