"""Whisper large-v3-turbo on the GPU through ONNX Runtime + DirectML (works with AMD/Intel/NVIDIA on Windows).

Exposes the subset of faster-whisper's API that whisper_worker.py uses:
    model = DmlWhisper(model_dir)
    segments, info = model.transcribe(audio, language="es", initial_prompt=..., hotwords=..., beam_size=...)
    for seg in segments: seg.text, seg.avg_logprob, seg.no_speech_prob

Models: onnx-community/whisper-large-v3-turbo (fp16 encoder + decoder + decoder_with_past), installed by
scripts/setup-whisper-gpu.ps1. Greedy decoding, no timestamps, Spanish by default.
"""
import math
import os
from dataclasses import dataclass

import numpy as np
import onnxruntime as ort

MAX_NEW_TOKENS = 160
MAX_PROMPT_TOKENS = 200


@dataclass
class Segment:
    text: str
    avg_logprob: float
    no_speech_prob: float


class DmlWhisper:
    def __init__(self, model_dir, device_id=0):
        from transformers import WhisperFeatureExtractor, WhisperTokenizerFast

        self.features = WhisperFeatureExtractor.from_pretrained(model_dir)
        self.tok = WhisperTokenizerFast.from_pretrained(model_dir)
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers = [("DmlExecutionProvider", {"device_id": device_id}), "CPUExecutionProvider"]
        onnx_dir = os.path.join(model_dir, "onnx")
        self.encoder = ort.InferenceSession(os.path.join(onnx_dir, "encoder_model_fp16.onnx"), opts, providers=providers)
        self.decoder = ort.InferenceSession(os.path.join(onnx_dir, "decoder_model_fp16.onnx"), opts, providers=providers)
        self.decoder_past = ort.InferenceSession(os.path.join(onnx_dir, "decoder_with_past_model_fp16.onnx"), opts, providers=providers)
        self.dec_inputs = [i.name for i in self.decoder.get_inputs()]
        self.past_inputs = [i.name for i in self.decoder_past.get_inputs()]
        self.past_outputs = [o.name for o in self.decoder_past.get_outputs()]
        self.dec_outputs = [o.name for o in self.decoder.get_outputs()]
        self.float_type = np.float16 if "float16" in self.encoder.get_inputs()[0].type else np.float32
        t = self.tok
        self.sot = t.convert_tokens_to_ids("<|startoftranscript|>")
        self.sot_prev = t.convert_tokens_to_ids("<|startofprev|>")
        self.eot = t.convert_tokens_to_ids("<|endoftext|>")
        self.transcribe_tok = t.convert_tokens_to_ids("<|transcribe|>")
        self.no_timestamps = t.convert_tokens_to_ids("<|notimestamps|>")
        self.no_speech = t.convert_tokens_to_ids("<|nospeech|>")
        self.first_timestamp = t.convert_tokens_to_ids("<|0.00|>")

    def _lang(self, language):
        return self.tok.convert_tokens_to_ids(f"<|{language}|>")

    def transcribe(self, audio, language="es", initial_prompt=None, hotwords=None, **_ignored):
        feats = self.features(audio, sampling_rate=16000, return_tensors="np").input_features.astype(self.float_type)
        enc = self.encoder.run(None, {self.encoder.get_inputs()[0].name: feats})[0]

        prompt_text = " ".join(p for p in (hotwords, initial_prompt) if p)
        prefix = []
        if prompt_text:
            ids = self.tok.encode(" " + prompt_text.strip(), add_special_tokens=False)[-MAX_PROMPT_TOKENS:]
            prefix = [self.sot_prev] + ids
        start = prefix + [self.sot, self._lang(language), self.transcribe_tok, self.no_timestamps]

        # First pass: whole prefix, no cache.
        out = self.decoder.run(None, {"input_ids": np.array([start], dtype=np.int64), "encoder_hidden_states": enc})
        named = dict(zip(self.dec_outputs, out))
        logits = named["logits"][0, -1].astype(np.float32)
        no_speech_prob = 0.0
        if self.no_speech is not None and self.no_speech >= 0:
            # Probability of <|nospeech|> right after <|startoftranscript|> (index of sot in the sequence).
            sot_logits = named["logits"][0, len(prefix)].astype(np.float32)
            sot_probs = _softmax(sot_logits)
            no_speech_prob = float(sot_probs[self.no_speech])
        past = {name.replace("present", "past_key_values"): value for name, value in named.items() if name.startswith("present")}

        tokens, logprobs = [], []
        for _ in range(MAX_NEW_TOKENS):
            logits[self.first_timestamp:] = -np.inf  # text only
            logits[self.sot_prev] = -np.inf
            token = int(np.argmax(logits))
            logprobs.append(float(_log_softmax(logits)[token]))
            if token == self.eot:
                break
            tokens.append(token)
            feed = {"input_ids": np.array([[token]], dtype=np.int64)}
            for name in self.past_inputs:
                if name.startswith("past_key_values"):
                    feed[name] = past[name]
            if "encoder_hidden_states" in self.past_inputs:
                feed["encoder_hidden_states"] = enc
            out = self.decoder_past.run(None, feed)
            named = dict(zip(self.past_outputs, out))
            logits = named["logits"][0, -1].astype(np.float32)
            for name, value in named.items():
                if name.startswith("present") and ".decoder." in name:
                    past[name.replace("present", "past_key_values")] = value
        text = self.tok.decode(tokens, skip_special_tokens=True).strip()
        avg = sum(logprobs) / len(logprobs) if logprobs else -10.0
        return [Segment(text=text, avg_logprob=avg, no_speech_prob=no_speech_prob)] if text else [], None


def _softmax(x):
    x = x - np.max(x)
    e = np.exp(x)
    return e / e.sum()


def _log_softmax(x):
    m = np.max(x)
    return x - m - math.log(np.exp(x - m).sum())
