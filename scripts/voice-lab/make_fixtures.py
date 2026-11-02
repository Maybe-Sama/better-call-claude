"""Voice lab fixtures: synthetic speech for the conversation scenarios (no real recordings).

  python make_fixtures.py <scenarios.json> <out_dir> [--provider edge|kokoro]

Each scenario is a list of parts {"say": text, "pause_after": seconds}. Every part is synthesised,
resampled to 16 kHz mono, trimmed to its speech and laid out with the given pauses. All scenarios go
into ONE WAV (8 s of silence between them, so the worker loads Whisper once) plus timeline.json with
the exact start/end of every part in audio time. Synthetic voice: es-ES-ElviraNeural (Edge) or
Kokoro em_alex, so the "user" never sounds like Claude's own voice.
"""
import argparse
import asyncio
import io
import json
import os
import sys
import wave

import numpy as np

RATE = 16000
GAP_BETWEEN_SCENARIOS_S = 8.0  # longer than any end-of-turn wait, so each turn is judged on its own
LEAD_IN_S = 1.5  # lets the worker's noise floor settle before the first phrase


def resample(samples, rate):
    if rate == RATE:
        return samples.astype(np.float32)
    n = int(round(len(samples) * RATE / rate))
    return np.interp(np.linspace(0, len(samples) - 1, n), np.arange(len(samples)), samples).astype(np.float32)


def trim(samples, threshold=0.01):
    """Cut the synthesiser's leading/trailing silence so part boundaries are the speech itself."""
    frame = 160
    loud = [i for i in range(0, len(samples) - frame, frame) if np.sqrt(np.mean(samples[i:i + frame] ** 2)) > threshold]
    if not loud:
        return samples
    return samples[max(0, loud[0] - frame):min(len(samples), loud[-1] + 2 * frame)]


class Edge:
    def __init__(self, voice="es-ES-ElviraNeural"):
        import edge_tts  # noqa: F401
        import soundfile  # noqa: F401
        self.voice = voice

    def say(self, text):
        import edge_tts
        import soundfile

        async def run():
            data = bytearray()
            async for chunk in edge_tts.Communicate(text, self.voice).stream():
                if chunk["type"] == "audio":
                    data.extend(chunk["data"])
            return bytes(data)

        samples, rate = soundfile.read(io.BytesIO(asyncio.run(run())), dtype="float32")
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        return resample(samples, rate)


class KokoroVoice:
    def __init__(self, voice="em_alex"):
        from kokoro_onnx import Kokoro
        models = os.path.join(os.environ.get("LOCALAPPDATA", "."), "AgentCall", "models", "kokoro")
        self.k = Kokoro(os.path.join(models, "kokoro-v1.0.onnx"), os.path.join(models, "voices-v1.0.bin"))
        self.voice = voice

    def say(self, text):
        samples, rate = self.k.create(text, voice=self.voice, speed=1.0, lang="es")
        return resample(np.asarray(samples, dtype=np.float32), rate)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("scenarios")
    parser.add_argument("out_dir")
    parser.add_argument("--provider", default="edge", choices=["edge", "kokoro"])
    args = parser.parse_args()

    scenarios = json.load(open(args.scenarios, encoding="utf-8"))
    try:
        voice = Edge() if args.provider == "edge" else KokoroVoice()
        provider = args.provider
    except Exception as exc:  # no edge-tts / mp3 support: offline voice
        print(f"edge unavailable ({exc}); using kokoro", file=sys.stderr)
        voice, provider = KokoroVoice(), "kokoro"

    audio = [np.zeros(int(LEAD_IN_S * RATE), dtype=np.float32)]
    cursor = LEAD_IN_S
    timeline = []
    for sc in scenarios:
        parts = []
        for part in sc["parts"]:
            try:
                samples = trim(voice.say(part["say"]))
            except Exception as exc:
                if provider == "kokoro":
                    raise
                print(f"edge failed on {part['say']!r} ({exc}); switching to kokoro", file=sys.stderr)
                voice, provider = KokoroVoice(), "kokoro"
                samples = trim(voice.say(part["say"]))
            start = cursor
            cursor += len(samples) / RATE
            parts.append({"say": part["say"], "start": round(start, 3), "end": round(cursor, 3)})
            audio.append(samples)
            pause = float(part.get("pause_after", 0))
            if pause:
                audio.append(np.zeros(int(pause * RATE), dtype=np.float32))
                cursor += pause
        timeline.append({**{k: v for k, v in sc.items() if k != "parts"}, "parts": parts})
        audio.append(np.zeros(int(GAP_BETWEEN_SCENARIOS_S * RATE), dtype=np.float32))
        cursor += GAP_BETWEEN_SCENARIOS_S

    os.makedirs(args.out_dir, exist_ok=True)
    pcm = np.clip(np.concatenate(audio), -1.0, 1.0)
    pcm = (pcm / max(1e-6, np.max(np.abs(pcm))) * 0.6 * 32767).astype("<i2")  # normal speaking level
    with wave.open(os.path.join(args.out_dir, "scenarios.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    json.dump({"provider": provider, "rate": RATE, "seconds": round(cursor, 2), "scenarios": timeline},
              open(os.path.join(args.out_dir, "timeline.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({"provider": provider, "seconds": round(cursor, 2), "scenarios": len(timeline)}))


if __name__ == "__main__":
    sys.exit(main())
