'use strict';
// Voice latency metrics and conversational failure counters (docs/voice-first/SPEC.md §9, §24).
// Only timings, categories and sizes are kept: an entry can never carry what anyone said. A ring
// buffer feeds the summary; an optional sink (config "voiceMetrics": true) appends JSONL lines.
const fs = require('node:fs');

// §24 failure categories.
const FAILURES = [
  'premature_endpoint', 'late_endpoint', 'false_speech_start', 'missed_bargein', 'false_bargein_echo',
  'wrong_transcription', 'low_confidence_submitted', 'speech_lost', 'late_correction', 'slow_tts', 'verbose_response',
];

// Extra fields an entry may carry: short labels and numbers only, never free text.
const LABELS = new Set(['kind', 'route', 'urgency', 'engine', 'source', 'turn', 'phase']);
const NUMBERS = new Set(['chars', 'words', 'count', 'seq']);
const LABEL = /^[a-z][a-z0-9_.-]{0,23}$/i;
// Metric names are dotted identifiers ("bargein.stop_ms"); anything else is stored as "invalid".
const NAME = /^[a-z][a-z0-9_]{0,23}(\.[a-z0-9_]{1,23}){0,3}$/;

function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

class VoiceMetrics {
  constructor({ capacity = 2000, sink = null, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.sink = sink;
    this.now = now;
    this.items = [];
    this.failures = Object.fromEntries(FAILURES.map(f => [f, 0]));
  }

  record(name, ms, extra = {}) {
    const entry = { at: this.now(), name: NAME.test(String(name)) ? String(name) : 'invalid', ms: Number.isFinite(ms) ? Math.round(ms) : null };
    for (const [key, value] of Object.entries(extra || {})) {
      if (LABELS.has(key) && typeof value === 'string' && LABEL.test(value)) entry[key] = value;
      else if (NUMBERS.has(key) && Number.isFinite(value)) entry[key] = Math.round(value);
    }
    this.items.push(entry);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    if (this.sink) {
      try { this.sink(JSON.stringify(entry)); } catch { /* metrics must never break a call */ }
    }
    return entry;
  }

  fail(category, extra = {}) {
    if (!(category in this.failures)) throw new Error(`unknown failure ${category}`);
    this.failures[category] += 1;
    return this.record(`fail.${category}`, null, extra);
  }

  entries() { return this.items.slice(); }

  summary() {
    const byName = {};
    for (const e of this.items) if (e.ms != null) (byName[e.name] ||= []).push(e.ms);
    const metrics = {};
    for (const [name, values] of Object.entries(byName)) {
      metrics[name] = { count: values.length, p50: percentile(values, 50), p90: percentile(values, 90), max: Math.max(...values) };
    }
    return { metrics, failures: { ...this.failures } };
  }
}

// Appends JSONL lines; write errors are ignored (a full disk must not break a call).
function jsonlSink(file) {
  return line => fs.appendFile(file, `${line}\n`, () => {});
}

module.exports = { VoiceMetrics, jsonlSink, percentile, FAILURES };
