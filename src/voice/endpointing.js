'use strict';
// End-of-turn policies. A policy is fed speech events with their time (ms) and keeps `deadline`:
// the time at which the user's turn is committed if nothing else happens (null = keep waiting).
// The driver (VoiceConversation in the app, the voice lab's simulator) arms a timer for `deadline`
// and calls `take()` when it fires. Policies never read the clock themselves.

// ── Legacy: the renderer's fixed timers up to 8eb1313 (kept as the voice lab baseline) ─────────

const LEGACY = {
  submitMs: 1500,        // questions / permissions
  submitFreeMs: 3000,    // free reply to a result
  thinkingMs: 5000,      // last words announce more ("y…", "pero…")
  minVisibleMs: 1200,    // the transcript is visible at least this long before sending
  minConfidence: 0.4,
};
const THINKING_TAIL = /(\b(y|o|e|u|pero|que|porque|entonces|adem[aá]s|tambi[eé]n|aparte|eh|em|mm|bueno|pues|a ver|o sea|es decir|como|tipo|luego|despu[eé]s|a[nñ]adir|decir|comentar|otra cosa)|\.\.\.|…|,)\s*[.,…]*\s*$/i;

class LegacyEndpointer {
  constructor({ kind = 'stop' } = {}) {
    this.kind = kind;
    this.reset();
  }

  reset() {
    this.parts = [];
    this.speaking = false;
    this.speechEndedAt = 0;
    this.deadline = null;
  }

  speechStart() {
    this.speaking = true;
    this.deadline = null;
  }

  speechEnd(t) {
    this.speaking = false;
    this.speechEndedAt = t;
    this._schedule(t);
  }

  partial(t) {
    if (this.deadline != null) this._schedule(t);
  }

  final(t, text, confidence = 1) {
    if (text && confidence >= LEGACY.minConfidence) this.parts.push(text);
    this._schedule(t);
  }

  text() { return this.parts.join(' ').trim(); }

  take() {
    const text = this.text();
    this.reset();
    return text;
  }

  _schedule(t) {
    if (this.speaking || !this.parts.length) { this.deadline = null; return; }
    const thinking = THINKING_TAIL.test(this.parts.at(-1));
    const silence = thinking ? LEGACY.thinkingMs : this.kind === 'stop' ? LEGACY.submitFreeMs : LEGACY.submitMs;
    const since = this.speechEndedAt ? t - this.speechEndedAt : 0;
    this.deadline = t + Math.max(LEGACY.minVisibleMs, silence - since);
  }
}

module.exports = { LegacyEndpointer, THINKING_TAIL, LEGACY };
