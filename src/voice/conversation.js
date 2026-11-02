'use strict';
// VoiceConversation: the turn-taking brain of an AgentCall call (docs/voice-first/PLAN.md).
//
// Explicit state on three axes instead of a pile of timers:
//   turn     what Claude is doing: 'idle' (no call) | 'awaitingUser' (a held question, permission or
//            result is waiting for the user) | 'working' (Claude got the answer and is busy) |
//            'informing' (call open, nothing held: e.g. an error)
//   speaking Claude's voice (or an acknowledgement) is playing
//   user     'silent' | 'speaking' | 'endpointing' (finished a phrase, deciding if the turn is over) |
//            'holding' ("espera…": listen, do not send)
//
// Inputs: setCall(), stt(), tts(), setMuted(), adoptDraft()/setTyping()/submitTyped().
// Outputs: 'speak' {id,text} · 'tts' {action:'stop'} · 'ack' {id,phrase} · 'commit' {...} · 'append'
// {text} (typing mode) · 'ui' snapshot · 'metric' {name,ms}. Delivery to Claude goes through the
// injected `deliver(commit)`, which returns the broker's result. The microphone stays open for the whole
// call: whatever is said while Claude works is committed as steering, never dropped.
const { EventEmitter } = require('node:events');
const { LegacyEndpointer } = require('./endpointing');

const HOLD_MS = 8000;          // a lone "espera" while Claude works is delivered as an interrupt after this
const ECHO_TAIL_MS = 4000;     // after Claude stops speaking, a recognition may still be its echo (Whisper is ~1 s late)
const MIN_CONFIDENCE = 0.4;    // below this, recognitions are noise/echo guesses ("Orlando" 0.11)
const ACK_TEXT = { vale: 'Vale.', entendido: 'Entendido.', momento: 'Un momento.' };

function fold(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set(['que', 'los', 'las', 'del', 'por', 'para', 'con', 'una', 'uno', 'unos', 'unas', 'como', 'pero', 'mas', 'este', 'esta', 'eso', 'esto', 'muy', 'hay', 'sus', 'les', 'nos', 'ese', 'esa']);
function contentWords(text) { return fold(text).split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w)); }

// Conversational signals, not commands. Speech that reacts to what Claude is doing right now.
const INTERRUPT_START = /^(no|para|alto|basta|detente|stop|espera|un momento|un segundo)\b/;
const INTERRUPT_ANY = /\b(me he equivocado|me equivoque|me he explicado mal|corrijo|queria decir|antes de (eso|seguir|nada|hacer|continuar)|no hagas|no sigas|dejalo|olvidalo|cancela|cambio de planes)\b/;
function classifyUrgency(text) {
  const t = fold(text);
  return INTERRUPT_START.test(t) || INTERRUPT_ANY.test(t) ? 'interrupt' : 'queue';
}

// The whole utterance only asks for time ("espera", "un momento", "a ver…"): keep listening.
const HOLD_ONLY = /^((no )?(espera|un momento|un segundo|dejame pensar|a ver|eh|em|mm|pues)( |$))+$/;
// Local, high-confidence intents about Claude's own speech (whole utterance only).
const RESUME = /^((vale|si|venga) )?(sigue|continua|adelante)( sigue)?$/;
const REPEAT = /^(repite(me)?( lo ultimo| eso| la ultima frase)?|que (estabas diciendo|decias|has dicho)|perdona que|como dices)$/;

const RESPONDING = new Set(['ask', 'permission', 'stop']);

class VoiceConversation extends EventEmitter {
  constructor({
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = id => clearTimeout(id),
    policy = kind => new LegacyEndpointer({ kind }),
    deliver = null,
  } = {}) {
    super();
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.makePolicy = policy;
    this.deliver = deliver;
    this.call = null;
    this.turn = 'idle';
    this.kind = null;
    this.muted = false;
    this.typing = false;
    this.spokenKeys = new Set();
    this.playing = null;            // utterance playing: { id, text, chunks: Map(seq → text), current, startedAt, ack }
    this.lastPlayed = null;        // the previous one (echo filter, "repíteme")
    this.interrupted = null;    // utterance cut by the user, for "sigue"
    this.pendingSpeak = null;   // a Claude message that arrived while the user was talking
    this.counter = 0;
    this.endpointTimer = null;
    this.holdTimer = null;
    this._resetDraft();
  }

  // ── Inputs ──────────────────────────────────────────────────────────────

  setCall(call) {
    const previous = this.call?.id || null;
    this.call = call || null;
    if ((call?.id || null) !== previous) {
      this._resetDraft();
      this.interrupted = null;
      this.pendingSpeak = null;
    }
    this.kind = call?.interactionKind || null;
    this.turn = !call ? 'idle'
      : RESPONDING.has(call.interactionKind) && call.waiting && !call.awaitingClaude ? 'awaitingUser'
        : call.awaitingClaude ? 'working' : 'informing';
    if (call) this._maybeSpeak(call);
    this._ui();
  }

  setMuted(value) {
    this.muted = Boolean(value);
    if (this.muted) this._resetDraft();
    this._ui();
  }

  listening() { return Boolean(this.call) && !this.muted; }

  stt(ev) {
    if (!this.listening()) return;
    if (ev.type === 'speech' && ev.state === 'start') this._speechStart(ev);
    else if (ev.type === 'speech' && ev.state === 'end') this._speechEnd(ev);
    else if (ev.type === 'partial') this._partial(String(ev.text || ''));
    else if (ev.type === 'final') this._final(String(ev.text || ''), typeof ev.confidence === 'number' ? ev.confidence : 1);
    else return;
    this._ui();
  }

  // Playback progress reported by the renderer: 'chunk' when a sentence starts playing, 'end' when done.
  tts(ev) {
    const cur = this.playing;
    if (!cur || ev.id !== cur.id) return;
    if (ev.type === 'chunk') {
      if (!cur.chunks.size && !cur.ack) this._metric('tts.first_audio_ms', this.now() - cur.startedAt);
      cur.chunks.set(ev.seq, String(ev.text || ''));
      cur.current = ev.seq;
    } else if (ev.type === 'end') {
      this._finishTts(Boolean(ev.interrupted));
      if (this.deferredCommit) { this.deferredCommit = false; this._onDeadline(); }
    }
    this._ui();
  }

  // The user started typing: the spoken draft moves to the text box; later recognitions are appended there.
  adoptDraft() {
    const text = this._draftText();
    this._resetDraft();
    this.typing = true;
    this._ui();
    return text;
  }

  setTyping(value) { this.typing = Boolean(value); }

  // Enter / Enviar. Empty text sends the spoken draft right away.
  submitTyped(text) {
    const clean = String(text || '').trim();
    const value = clean || this._draftText();
    this.typing = false;
    if (!value) return { ok: false, error: 'No hay nada que enviar.' };
    return this._commit(value, 'typed');
  }

  // ── Speech recognition ──────────────────────────────────────────────────

  _speechStart(ev) {
    this.userSpeaking = true;
    this.speechStartAt = this.now() - (Number(ev.onset_ms) || 0);
    this.sawPartial = false;
    this._clearHoldTimer();
    this._policy().speechStart(this.now());
    this._arm();
  }

  _speechEnd(ev) {
    this.userSpeaking = false;
    this.speechEndAt = this.now() - (Number(ev.silence_ms) || 0);
    this._policy().speechEnd(this.now());
    this._arm();
    if (!this._draftText() && this.pendingSpeak) this._flushPendingSpeak();
    this._armHold();
  }

  _partial(text) {
    if (this.speaking() || this._inEchoTail()) {
      if (this._isEcho(text)) return; // Claude hearing itself through the speakers
      if (this.speaking() && contentWords(text).length >= 2) this._bargeIn();
    }
    if (!this.sawPartial && this.speechStartAt) this._metric('stt.first_partial_ms', this.now() - this.speechStartAt);
    this.sawPartial = true;
    this.partialText = text;
    this._policy().partial(this.now(), text);
    this._arm();
  }

  _final(text, confidence) {
    this.partialText = '';
    if (this.speechEndAt) this._metric('stt.final_ms', this.now() - this.speechEndAt);
    const policy = this._policy();
    if (!text || confidence < MIN_CONFIDENCE || this._isEcho(text)) {
      this.lowConfidence = Boolean(text) && confidence < MIN_CONFIDENCE;
      policy.final(this.now(), '', 0); // re-times the turn without adding anything
      this._arm();
      this._armHold();
      return;
    }
    this.lowConfidence = false;
    if (this.speaking()) this._bargeIn();
    if (this.typing) { this.emit('append', { text }); return; }
    policy.final(this.now(), text, confidence);
    this._arm();
  }

  // ── Claude's voice ──────────────────────────────────────────────────────

  speaking() { return Boolean(this.playing); }

  _maybeSpeak(call) {
    const latest = [...(call.messages || [])].reverse().find(m => m.role === 'assistant');
    if (!latest) return;
    const key = `${call.id}:${latest.at}`;
    if (this.spokenKeys.has(key)) return;
    this.spokenKeys.add(key);
    if (this.spokenKeys.size > 500) this.spokenKeys.delete(this.spokenKeys.values().next().value);
    const text = String(latest.speech || latest.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (this.userSpeaking || this._draftText()) { this.pendingSpeak = text; return; } // never talk over the user
    this._speak(text);
  }

  _speak(text) {
    if (this.playing) this._stopTts();
    this.counter += 1;
    this.playing = { id: `v${this.counter}`, text, chunks: new Map(), current: null, startedAt: this.now(), ack: false };
    this.interrupted = null;
    this.emit('speak', { id: this.playing.id, text });
  }

  _ack(phrase) {
    if (this.playing) this._stopTts();
    this.counter += 1;
    this.playing = { id: `ack${this.counter}`, text: ACK_TEXT[phrase], chunks: new Map(), current: null, startedAt: this.now(), ack: true };
    this.emit('ack', { id: this.playing.id, phrase });
  }

  _flushPendingSpeak() {
    const text = this.pendingSpeak;
    this.pendingSpeak = null;
    if (text) this._speak(text);
  }

  // The user talked over Claude: silence at once, remember where it was cut.
  _bargeIn() {
    if (!this.playing) return;
    if (this.speechStartAt) this._metric('bargein.stop_ms', this.now() - this.speechStartAt);
    if (!this.playing.ack) this.interrupted = { ...this.playing, chunks: new Map(this.playing.chunks) };
    this._stopTts();
  }

  _stopTts() {
    this.emit('tts', { action: 'stop' });
    this._finishTts(true);
  }

  _finishTts(interrupted) {
    if (!this.playing) return;
    this.lastPlayed = { ...this.playing, endedAt: this.now(), interrupted };
    this.playing = null;
  }

  _inEchoTail() { return Boolean(this.lastPlayed) && this.now() - this.lastPlayed.endedAt <= ECHO_TAIL_MS; }

  // Without headphones Claude's voice reaches the microphone: a recognition whose words mostly come
  // from what Claude is (or was just) saying is its own echo.
  _isEcho(text) {
    const ref = this.playing || (this._inEchoTail() ? this.lastPlayed : null);
    if (!ref) return false;
    const heard = contentWords(text);
    if (!heard.length) return Boolean(this.playing);
    const spoken = new Set(contentWords(ref.text));
    return heard.filter(w => spoken.has(w)).length / heard.length >= 0.6;
  }

  // Text from the sentence that was playing when the user cut in, to the end of the message.
  _remainder(utt) {
    if (!utt) return '';
    const cut = utt.chunks.get(utt.current);
    const at = cut ? utt.text.indexOf(cut) : -1;
    return (at >= 0 ? utt.text.slice(at) : utt.text).trim();
  }

  _localIntent(text) {
    const t = fold(text);
    if (RESUME.test(t) && this.interrupted) {
      const rest = this._remainder(this.interrupted);
      this.interrupted = null;
      if (rest) { this.emit('local', { intent: 'resume' }); this._speak(rest); return true; }
    }
    if (REPEAT.test(t) && (this.interrupted || this.lastPlayed)) {
      const source = this.interrupted || (this.lastPlayed && !this.lastPlayed.ack ? this.lastPlayed : null);
      const again = this.interrupted ? this._remainder(this.interrupted) : source?.text;
      this.interrupted = null;
      if (again) { this.emit('local', { intent: 'repeat' }); this._speak(again); return true; }
    }
    return false;
  }

  // ── End of turn ─────────────────────────────────────────────────────────

  _policy() {
    if (!this.policy) this.policy = this.makePolicy(this.turn === 'awaitingUser' ? this.kind : 'stop');
    return this.policy;
  }

  _draftText() {
    const spoken = this.policy ? this.policy.text() : '';
    return [this.prefix, spoken, this.partialText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  _arm() {
    if (this.endpointTimer) this.clearTimer(this.endpointTimer);
    this.endpointTimer = null;
    const deadline = this.policy?.deadline;
    if (deadline == null) return;
    this.endpointTimer = this.setTimer(() => { this.endpointTimer = null; this._onDeadline(); }, Math.max(0, deadline - this.now()));
  }

  _onDeadline() {
    if (this.playing && !this.playing.ack) { this.deferredCommit = true; return; } // never answer while Claude is still talking
    const spoken = this.policy ? this.policy.take() : '';
    const text = [this.prefix, spoken].filter(Boolean).join(' ').trim();
    if (!text) return this._ui();
    if (!this.prefix && this._localIntent(text)) { this._resetDraft(); return this._ui(); }
    if (HOLD_ONLY.test(fold(text))) {
      // "Espera…": Claude stops and listens; the words stay as the start of what comes next.
      this.prefix = text;
      this.holding = true;
      if (this.playing) this._stopTts();
      this._armHold();
      return this._ui();
    }
    this._commit(text, 'voice');
  }

  _armHold() {
    if (!this.holding || this.userSpeaking || this.policy?.deadline != null || this.turn === 'awaitingUser') return;
    this._clearHoldTimer();
    this.holdTimer = this.setTimer(() => {
      this.holdTimer = null;
      if (this.holding && !this.userSpeaking && this.prefix) this._commit(this.prefix, 'voice');
    }, HOLD_MS);
  }

  _clearHoldTimer() {
    if (this.holdTimer) this.clearTimer(this.holdTimer);
    this.holdTimer = null;
  }

  _commit(text, source) {
    const route = this.turn === 'awaitingUser' ? 'answer' : 'steer';
    const commit = {
      callId: this.call?.id || null,
      sessionId: this.call?.sessionId || null,
      text,
      route,
      urgency: route === 'steer' ? classifyUrgency(text) : null,
      kind: this.kind,
      source,
    };
    if (source === 'voice' && this.speechEndAt) this._metric('turn.endpoint_ms', this.now() - this.speechEndAt);
    this._resetDraft();
    if (route === 'answer') this.pendingSpeak = null; // the user moved on: an unheard older message is stale
    this.emit('commit', commit);
    const result = this.deliver ? this.deliver(commit) : null;
    if (result) this.committed({ ...commit, ...result });
    if (this.pendingSpeak) this._flushPendingSpeak();
    this._ui();
    return result;
  }

  // Acknowledge only what deserves it: never after "para"/"espera", "un momento" before a clarification.
  committed({ ok, route, urgency, text, clarification }) {
    if (!ok || this.muted) return;
    let phrase = 'vale';
    if (route === 'steer' && urgency === 'interrupt') phrase = null;
    else if (route === 'answer' && (clarification || /\?\s*$/.test(String(text || '')))) phrase = 'momento';
    if (phrase) this._ack(phrase);
  }

  _resetDraft() {
    if (this.endpointTimer) this.clearTimer(this.endpointTimer);
    this.endpointTimer = null;
    this._clearHoldTimer();
    this.policy = null;
    this.partialText = '';
    this.userSpeaking = false;
    this.lowConfidence = false;
    this.prefix = '';
    this.holding = false;
    this.deferredCommit = false;
    this.speechStartAt = 0;
    this.speechEndAt = 0;
  }

  // ── Output ──────────────────────────────────────────────────────────────

  snapshot() {
    const deadline = this.policy?.deadline;
    return {
      turn: this.turn,
      kind: this.kind,
      speaking: this.speaking() && !this.playing?.ack,
      user: this.userSpeaking ? 'speaking' : deadline != null ? 'endpointing' : this.holding ? 'holding' : 'silent',
      listening: this.listening(),
      draft: [this.prefix, this.policy ? this.policy.text() : ''].filter(Boolean).join(' ').trim(),
      partial: this.partialText,
      deadlineIn: deadline != null ? Math.max(0, deadline - this.now()) : null,
      holding: this.holding,
      lowConfidence: this.lowConfidence,
      canResume: Boolean(this.interrupted),
    };
  }

  _ui() { this.emit('ui', this.snapshot()); }

  _metric(name, ms) { if (Number.isFinite(ms)) this.emit('metric', { name, ms: Math.round(ms) }); }
}

module.exports = { VoiceConversation, classifyUrgency, contentWords, HOLD_MS, ACK_TEXT };
