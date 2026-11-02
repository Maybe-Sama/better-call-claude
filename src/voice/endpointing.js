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

// Two numbers per class: how long to wait once the transcript is there, and the minimum silence since
// the voice really stopped (speculative transcripts can arrive while a natural pause is still going on).
const ADAPTIVE = {
  minSilenceMs: 300,    // never commit sooner than this after the end-of-speech event
  shortMs: 120,         // "sí" / "la segunda" while Claude waits for a permission or a choice
  shortFloorMs: 600,
  completeMs: 300,      // ends like a sentence (. ! ?)
  completeFloorMs: 1000, // free reply; 800 when answering a question
  openMs: 900,          // no closing punctuation, but nothing announcing more either
  openFloorMs: 1600,
  unfinishedMs: 4500,   // conjunction, filler, comma, "…", "luego", "un momento": the user is still thinking
  perPhraseMs: 700,     // a turn of several phrases (explaining, reading) gets this much more patience per phrase
  maxPhraseBonusMs: 2000,
  finalTimeoutMs: 3000, // a transcript that has not come by then (noise being transcribed) does not hold the turn
  shortCommandFloorMs: 2500, // a lone short command in a free reply ("Ponlo azul.") is often corrected after a pause
  minConfidence: 0.4,
};

function fold(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[¿¡]/g, '').trim();
}

const UNFINISHED_EXTRA = /(\b(primero|segundo|despues|antes|mientras|cuando|aunque|osea|o sea)|:)\s*$/;
// The phrase announces what comes next ("mira, una cosa:", "te cuento", "es que…").
const ANNOUNCES = /(^|\W)(una cosa|otra cosa|te cuento|te digo|mira|escucha|fijate|es que|lo que quiero( es)?|lo que pasa( es)?( que)?|la cosa es( que)?|a ver si|resulta que)[\s.,…:!]*$/;
// Below this confidence a transcript is probably a cut or garbled phrase: give the user time.
const DOUBTFUL_CONFIDENCE = 0.6;
// The last phrase only asks for time.
const HOLD_TAIL = /(^|[.,;!?]\s*)(no,? )?(espera|un momento|un segundo|dejame pensar|deja que piense|a ver|eh|em|mm|pues|bueno)[\s.,…!]*$/;
const SHORT_ANSWER = /^(si|no|vale|ok|okay|claro|venga|dale|adelante|de acuerdo|perfecto|correcto|hazlo|mejor no|para nada|ninguna|ninguno|todas|todos|(la |el |opcion )?(primera|segunda|tercera|cuarta|ultima|primero|segundo|tercero|cuarto|ultimo|uno|dos|tres|cuatro|[a-e]))\b/;

function wordCount(text) { return fold(text).replace(/[^a-z0-9ñ ]+/g, ' ').split(/\s+/).filter(Boolean).length; }

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

  speechStart(t) {
    this.vadEvents = true;
    super.speechStart(t);
  }

  // Whisper reports speech start/end, so partials change nothing. Windows dictation (the fallback
  // engines) sends only partials and finals: a partial then means the user is still talking.
  partial() {
    if (this.vadEvents) return;
    this.speaking = true;
    this.deadline = null;
  }

  // expectFinal: false when the worker will not transcribe this phrase (too short, cancelled).
  // silenceMs: how long the worker waited in silence before reporting the end (voice stopped at t - silenceMs).
  speechEnd(t, { expectFinal = true, silenceMs = 0 } = {}) {
    if (expectFinal) this.pendingFinals += 1;
    this.voiceStoppedAt = t - (Number(silenceMs) || 0);
    super.speechEnd(t);
  }

  // A rejected phrase (no words) arrives as final(t, '', 0).
  final(t, text, confidence = 1) {
    if (!this.vadEvents) this.speaking = false; // without voice events, a final closes the phrase
    this.pendingFinals = Math.max(0, this.pendingFinals - 1);
    if (text && confidence >= ADAPTIVE.minConfidence) {
      this.parts.push(fixShortAnswer(text, this.options));
      this.lastConfidence = confidence;
    }
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
    const answering = this.kind === 'permission' || this.kind === 'ask';
    let wait;
    let floor;
    const folded = fold(last);
    const doubtful = (this.lastConfidence ?? 1) < DOUBTFUL_CONFIDENCE && !(answering && this.isShortAnswer(this.text()));
    if (THINKING_TAIL.test(last) || UNFINISHED_EXTRA.test(folded) || HOLD_TAIL.test(folded) || ANNOUNCES.test(folded) || doubtful) {
      wait = ADAPTIVE.unfinishedMs;
      floor = 0;
    } else if (answering && this.isShortAnswer(this.text())) {
      wait = ADAPTIVE.shortMs;
      floor = ADAPTIVE.shortFloorMs;
    } else if (/[.!?]["»)]?\s*$/.test(last)) {
      wait = ADAPTIVE.completeMs;
      floor = answering ? ADAPTIVE.completeFloorMs - 200 : ADAPTIVE.completeFloorMs;
      // Live tests: "Ponlo azul. (pausa) No, perdona, verde", "Sube esto a producción. (pausa) bueno, no…".
      if (!answering && this.parts.length === 1 && !/\?\s*$/.test(last) && !this.isShortAnswer(last) && wordCount(last) <= 5) floor = ADAPTIVE.shortCommandFloorMs;
    } else {
      wait = ADAPTIVE.openMs;
      floor = ADAPTIVE.openFloorMs;
    }
    // Someone explaining or reading at length pauses between sentences: the longer the turn, the
    // longer a pause has to be before it counts as the end.
    if (floor) floor += Math.min(ADAPTIVE.maxPhraseBonusMs, ADAPTIVE.perPhraseMs * (this.parts.length - 1));
    const ended = this.speechEndedAt || t;
    const stopped = this.voiceStoppedAt ?? ended;
    this.deadline = Math.max(t + wait, ended + ADAPTIVE.minSilenceMs, stopped + floor);
  }
}

module.exports = { LegacyEndpointer, AdaptiveEndpointer, fixShortAnswer, THINKING_TAIL, LEGACY, ADAPTIVE };
