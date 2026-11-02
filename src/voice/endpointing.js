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

// ── Adaptive: silence since the voice ended + what the words say (Voice First §8) ──────────────
// The transcript of a phrase only exists once the worker has heard ~0.7 s of silence, so the policy
// decides from that moment how much MORE to wait: almost nothing for "sí" to a permission, half a
// second for a finished sentence, seconds when the words point forward ("y…", "pues…", "luego").
// Fixed timers remain only as the floor (minSilenceMs) and the ceiling of each class.

const ADAPTIVE = {
  minSilenceMs: 300,    // never commit sooner than this after the voice stops
  shortMs: 120,         // "sí" / "la segunda" while Claude waits for a permission or a choice
  completeMs: 500,      // ends like a sentence (. ! ?)
  openMs: 1100,         // no closing punctuation, but nothing announcing more either
  unfinishedMs: 2800,   // conjunction, filler, comma, "…", "luego": the user is still thinking
  finalTimeoutMs: 6000, // safety: a transcript that never arrives does not block the turn forever
  minConfidence: 0.4,
};

function fold(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[¿¡]/g, '').trim();
}

const UNFINISHED_EXTRA = /(\b(primero|segundo|despues|antes|mientras|cuando|aunque|osea|o sea)|:)\s*$/;
const SHORT_ANSWER = /^(si|no|vale|ok|okay|claro|venga|dale|adelante|de acuerdo|perfecto|correcto|hazlo|mejor no|para nada|ninguna|ninguno|todas|todos|(la |el |opcion )?(primera|segunda|tercera|cuarta|ultima|primero|segundo|tercero|cuarto|ultimo|uno|dos|tres|cuatro|[a-e]))\b/;

// Whisper writes a lone Spanish "sí" as the letter "C." surprisingly often.
function fixShortAnswer(text, options = []) {
  const t = fold(text).replace(/[.!,]+$/, '');
  if ((t === 'c' || t === 'ce') && !options.some(o => fold(o) === 'c')) return 'Sí.';
  return text;
}

class AdaptiveEndpointer extends LegacyEndpointer {
  constructor({ kind = 'stop', options = [] } = {}) {
    super({ kind });
    this.options = (options || []).map(o => fold(typeof o === 'string' ? o : o?.label)).filter(Boolean);
  }

  reset() {
    super.reset();
    this.pendingFinals = 0; // phrases that ended and whose transcript has not arrived yet
  }

  partial() { /* partials only arrive while the user talks, and speechStart already cancelled */ }

  // expectFinal: false when the worker will not transcribe this phrase (too short, cancelled).
  speechEnd(t, { expectFinal = true } = {}) {
    if (expectFinal) this.pendingFinals += 1;
    super.speechEnd(t);
  }

  // A rejected phrase (no words) arrives as final(t, '', 0).
  final(t, text, confidence = 1) {
    this.pendingFinals = Math.max(0, this.pendingFinals - 1);
    if (text && confidence >= ADAPTIVE.minConfidence) this.parts.push(fixShortAnswer(text, this.options));
    this._schedule(t);
  }

  isShortAnswer(text) {
    const t = fold(text).replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.split(' ').length > 4) return false;
    return SHORT_ANSWER.test(t) || this.options.some(o => o && (t === o || t.endsWith(` ${o}`) || t.startsWith(`${o} `)));
  }

  _schedule(t) {
    if (this.speaking || !this.parts.length) { this.deadline = null; return; }
    // Deciding on the previous phrase while the newest one is still being transcribed sends half a turn.
    if (this.pendingFinals > 0) { this.deadline = (this.speechEndedAt || t) + ADAPTIVE.finalTimeoutMs; return; }
    const last = this.parts.at(-1);
    let wait;
    if (THINKING_TAIL.test(last) || UNFINISHED_EXTRA.test(fold(last))) wait = ADAPTIVE.unfinishedMs;
    else if ((this.kind === 'permission' || this.kind === 'ask') && this.isShortAnswer(this.text())) wait = ADAPTIVE.shortMs;
    else if (/[.!?]["»)]?\s*$/.test(last)) wait = ADAPTIVE.completeMs;
    else wait = ADAPTIVE.openMs;
    this.deadline = Math.max(t + wait, (this.speechEndedAt || t) + ADAPTIVE.minSilenceMs);
  }
}

module.exports = { LegacyEndpointer, AdaptiveEndpointer, fixShortAnswer, THINKING_TAIL, LEGACY, ADAPTIVE };
