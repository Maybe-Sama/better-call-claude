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
const { AdaptiveEndpointer } = require('./endpointing');

const MIN_TRANSCRIBED_MS = 350; // whisper_worker.py MIN_UTTERANCE_S: shorter phrases get no transcript

const HOLD_MS = 8000;          // a lone "espera" while Claude works is delivered as an interrupt after this
const ECHO_TAIL_MS = 4000;     // after Claude stops speaking, a recognition may still be its echo (Whisper is ~1 s late)
const MIN_CONFIDENCE = 0.4;    // below this, recognitions are noise/echo guesses ("Orlando" 0.11)
// With echo cancellation the voice detector is trusted: Claude ducks at the first speech frame and goes
// silent if the voice lasts this long (or words appear); shorter sounds (a cough) restore the volume.
const BARGE_CONFIRM_MS = 250;
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
    policy = (kind, options) => new AdaptiveEndpointer({ kind, options }),
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
    this.stopping = null;       // { id, at }: stop requested, waiting for the renderer to confirm silence
    this.counter = 0;
    this.endpointTimer = null;
    this.holdTimer = null;
    this.echoCancelled = false; // microphone captured with acoustic echo cancellation
    this.ducked = false;
    this.bargeTimer = null;
    this._resetDraft();
  }

  // Capture "aec" confirmed by the window: the microphone no longer hears Claude's own voice.
  setEchoCancelled(value) { this.echoCancelled = Boolean(value); }

  // ── Inputs ──────────────────────────────────────────────────────────────

  setCall(call) {
    const previous = this.call?.id || null;
    if ((call?.id || null) !== previous && this.call) this._flushDraft('la llamada ha terminado'); // to the call/session it belonged to
    this.call = call || null;
    if ((call?.id || null) !== previous) {
      // Another call (or none): nothing of the previous one may keep playing or count as echo.
      if (this.playing) this._stopTts();
      this._resetDraft();
      this.interrupted = null;
      this.pendingSpeak = null;
      this.lastPlayed = null;
    }
    this.kind = call?.interactionKind || null;
    this.turn = !call ? 'idle'
      : RESPONDING.has(call.interactionKind) && call.waiting && !call.awaitingClaude ? 'awaitingUser'
        : call.awaitingClaude ? 'working' : 'informing';
    if (call) this._maybeSpeak(call);
    this._ui();
  }

  setMuted(value) {
    if (value && !this.muted) this._flushDraft('micrófono silenciado');
    this.muted = Boolean(value);
    if (this.muted) this._resetDraft();
    this._ui();
  }

  // Recognised words still waiting for the end of the turn are sent now instead of being dropped
  // (hang-up, another call, mute). An unfinished partial is not: it was never a confirmed transcript.
  _flushDraft(reason) {
    const text = [this.prefix, this.policy ? this.policy.text() : ''].filter(Boolean).join(' ').trim();
    if (!text) return;
    this._debug(`${reason}: envío lo que ya habías dicho`);
    this._commit(text, 'voice');
  }

  listening() { return Boolean(this.call) && !this.muted; }

  stt(ev) {
    if (!this.listening()) return;
    if (ev.type === 'speech' && ev.state === 'start') this._speechStart(ev);
    else if (ev.type === 'speech' && ev.state === 'end') this._speechEnd(ev);
    else if (ev.type === 'partial') this._partial(String(ev.text || ''));
    else if (ev.type === 'final') this._final(String(ev.text || ''), typeof ev.confidence === 'number' ? ev.confidence : 1);
    else if (ev.type === 'rejected') this._final('', 0); // the phrase had no words
    else return;
    this._ui();
  }

  // Playback progress reported by the renderer: 'chunk' when a sentence starts playing, 'end' when done.
  tts(ev) {
    if (ev.type === 'end' && this.stopping?.id === ev.id) {
      this._metric('tts.stop_ms', this.now() - this.stopping.at); // stop requested → playback silent
      this.stopping = null;
    }
    const cur = this.playing;
    if (!cur || ev.id !== cur.id) return;
    if (ev.type === 'chunk') {
      if (!cur.chunks.size && !cur.ack) this._metric('tts.first_audio_ms', this.now() - cur.startedAt);
      cur.chunks.set(ev.seq, String(ev.text || ''));
      cur.current = ev.seq;
    } else if (ev.type === 'end') {
      this._finishTts(Boolean(ev.interrupted));
      if (this.deferredCommit && !this.userSpeaking) { this.deferredCommit = false; this._onDeadline(); }
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
    // A spoken draft nobody adopted still belongs to this turn: it goes first, never dropped.
    const value = [this._draftText(), clean].filter(Boolean).join(' ').trim();
    this.typing = false;
    if (!value) return { ok: false, error: 'No hay nada que enviar.' };
    return this._commit(value, 'typed');
  }

  // ── Speech recognition ──────────────────────────────────────────────────

  _speechStart(ev) {
    this.userSpeaking = true;
    this.deferredCommit = false; // the user went on talking: the turn is not over
    this.speechStartAt = this.now() - (Number(ev.onset_ms) || 0);
    this.phraseStartAt = this.speechStartAt; // kept across commits: decides whether a phrase can be echo
    this.sawPartial = false;
    this._clearHoldTimer();
    this._policy().speechStart(this.now());
    this._arm();
    if (this.echoCancelled && this.playing && !this.playing.ack) {
      this._duck();
      this._clearBargeTimer();
      this.bargeTimer = this.setTimer(() => { this.bargeTimer = null; this._bargeIn('voz sostenida'); }, BARGE_CONFIRM_MS);
    }
  }

  _speechEnd(ev) {
    this.userSpeaking = false;
    if (this.bargeTimer) {
      // Too short to be someone talking (cough, knock): Claude goes on at full volume.
      this._clearBargeTimer();
      if (this.ducked) {
        this.ducked = false;
        this.emit('tts', { action: 'unduck' });
        this.emit('failure', 'false_speech_start');
        this._debug('ruido breve: Claude sigue hablando');
      }
    }
    this.speechEndAt = this.now() - (Number(ev.silence_ms) || 0);
    const expectFinal = !ev.cancelled && (ev.voiced_ms == null || ev.voiced_ms >= MIN_TRANSCRIBED_MS);
    this._policy().speechEnd(this.now(), { expectFinal, silenceMs: Number(ev.silence_ms) || 0 });
    this._arm();
    if (!this._draftText() && this.pendingSpeak) this._flushPendingSpeak();
    this._armHold();
  }

  _partial(text) {
    if (this.speaking() || this._inEchoTail()) {
      if (this._isEcho(text)) return; // Claude hearing itself through the speakers
      const words = fold(text).split(' ').filter(Boolean).length;
      if (this.speaking() && (this.ducked ? words >= 1 : contentWords(text).length >= 2)) this._bargeIn('parcial');
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
      if (text) this._debug(this.lowConfidence ? `descarto (confianza ${confidence}): «${text}»` : `eco de Claude: «${text}»`);
      policy.final(this.now(), '', 0); // re-times the turn without adding anything
      this._arm();
      this._armHold();
      return;
    }
    this.lowConfidence = false;
    if (this.speaking()) this._bargeIn('final');
    if (this.typing) {
      this.emit('append', { text });
      policy.final(this.now(), '', 0); // the transcript arrived (it went to the box), the turn need not wait for it
      this._arm();
      return;
    }
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
    if (latest.silent) return; // shown in the call, not read (e.g. a result the user already moved past)
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
  _duck() {
    if (this.ducked) return;
    this.ducked = true;
    if (this.speechStartAt) this._metric('bargein.duck_ms', this.now() - this.speechStartAt);
    this.emit('tts', { action: 'duck' });
  }

  _clearBargeTimer() {
    if (this.bargeTimer) this.clearTimer(this.bargeTimer);
    this.bargeTimer = null;
  }

  _bargeIn(reason) {
    this._clearBargeTimer();
    this.ducked = false;
    if (!this.playing) return;
    this._debug(`interrumpe a Claude (${reason})`);
    if (this.speechStartAt) this._metric('bargein.stop_ms', this.now() - this.speechStartAt);
    if (!this.playing.ack) this.interrupted = { ...this.playing, chunks: new Map(this.playing.chunks) };
    this._stopTts();
  }

  _stopTts() {
    if (this.playing) this.stopping = { id: this.playing.id, at: this.now() };
    this.emit('tts', { action: 'stop' });
    this._finishTts(true);
  }

  _finishTts(interrupted) {
    this._clearBargeTimer();
    this.ducked = false;
    if (!this.playing) return;
    this.lastPlayed = { ...this.playing, endedAt: this.now(), interrupted };
    this.playing = null;
  }

  _inEchoTail() { return Boolean(this.lastPlayed) && this.now() - this.lastPlayed.endedAt <= ECHO_TAIL_MS; }

  // Without headphones Claude's voice reaches the microphone: a recognition whose words mostly come
  // from what Claude is (or was just) saying is its own echo.
  _isEcho(text) {
    if (this.echoCancelled) return false; // the microphone no longer hears Claude
    const ref = this.playing || (this._inEchoTail() ? this.lastPlayed : null);
    if (!ref) return false;
    // A phrase that began after Claude went quiet is the user's, even if it repeats Claude's words
    // ("¿Supabase o Neon?" → "Neon"). Only voice that started during playback can be its echo.
    if (!this.playing && this.phraseStartAt > ref.endedAt + 150) return false;
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
    if (!this.policy) {
      const options = this.turn === 'awaitingUser' && this.kind === 'ask' ? (this.call?.currentQuestion?.options || []).map(o => o.label) : [];
      this.policy = this.makePolicy(this.turn === 'awaitingUser' ? this.kind : 'stop', options);
    }
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
    if (this.playing && !this.playing.ack) { this.deferredCommit = true; this._debug('fin de turno aplazado: Claude habla'); return; } // never answer while Claude is still talking
    const spoken = this.policy ? this.policy.take() : '';
    const text = [this.prefix, spoken].filter(Boolean).join(' ').trim();
    if (!text) return this._ui();
    if (!this.prefix && this._localIntent(text)) { this._resetDraft(); return this._ui(); }
    if (HOLD_ONLY.test(fold(text))) {
      this._debug(`espera: «${text}»`);
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
    this._debug(`envía (${route}${commit.urgency ? ` ${commit.urgency}` : ''}, ${source}): «${text}»`);
    this._resetDraft();
    if (route === 'answer') this.pendingSpeak = null; // the user moved on: an unheard older message is stale
    this.emit('commit', commit);
    let result = null;
    try { result = this.deliver ? this.deliver(commit) : null; } catch (err) { result = { ok: false, error: err?.message || String(err) }; }
    if (result && typeof result.then === 'function') {
      return result.then(r => this._delivered(commit, r), err => this._delivered(commit, { ok: false, error: err?.message || String(err) }));
    }
    return this._delivered(commit, result);
  }

  // After delivery. A failure gives spoken words back (to the text box) so nothing said is lost.
  _delivered(commit, result) {
    if (result && result.ok === false) {
      if (commit.source === 'voice') this.emit('append', { text: commit.text });
      this.emit('error', { message: result.error || 'No se pudo enviar a Claude.' });
    } else if (result) {
      this.committed({ ...commit, ...result });
    }
    if (this.pendingSpeak) this._flushPendingSpeak();
    this._ui();
    return result;
  }

  // A quick-answer button (or anything outside the voice draft) answered the call.
  clearDraft() {
    this._resetDraft();
    this._ui();
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

  // Decisions for the console log (like the STT finals already are); never written to disk by this module.
  _debug(message) { this.emit('debug', message); }
}

module.exports = { VoiceConversation, classifyUrgency, contentWords, HOLD_MS, ACK_TEXT, BARGE_CONFIRM_MS };
