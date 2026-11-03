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
const { AdaptiveEndpointer, ADAPTIVE } = require('./endpointing');

const MIN_TRANSCRIBED_MS = 350; // whisper_worker.py MIN_UTTERANCE_S: shorter phrases get no transcript

const HOLD_MS = 8000;          // a lone "espera" while Claude works is delivered as an interrupt after this
const ECHO_TAIL_MS = 4000;     // after Claude stops speaking, a recognition may still be its echo (Whisper is ~1 s late)
const MIN_CONFIDENCE = 0.4;    // below this, recognitions are noise/echo guesses ("Orlando" 0.11)
// With echo cancellation the voice detector is trusted, but only as a person on the phone would be:
// a short sound (breath, "ajá", a key) changes nothing, a voice that goes on makes Claude lower its
// voice, and Claude stops for words (a transcript) or a voice that keeps going this long. Live test
// 2026-11-02: stopping at 250 ms cut Claude 20 times in four minutes, each time restarting the sentence.
const DUCK_AFTER_MS = 300;
const BARGE_CONFIRM_MS = 1500;
// Whisper reports the end of a phrase after this much silence (whisper_worker.py END_SILENCE_S): a voice
// "still going" BARGE_CONFIRM_MS after it started may have stopped up to this long ago.
const VAD_TAIL_MS = 700;
const DUCK_HOLD_MS = 3000; // longest wait for the transcript of a phrase that lowered Claude
const CUT_WAIT_MS = 3000;  // ✕ with Windows dictation: longest wait for the recognizer to confirm the cut
const DICTATION_LAG_MS = 800; // Windows dictation shows a phrase about this long after it began
const AUDIO_WAIT_MS = 5000;   // a sentence added to a quiet stream that never plays does not keep Claude "talking"
const PENDING_CHECK_MS = 500; // how often a message kept for later checks whether it can be said
const ACK_TEXT = { vale: 'Vale.', entendido: 'Entendido.', momento: 'Un momento.' };

function fold(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// tts_worker.py normalize(): the sentence the voice reports playing is the normalized one.
function ttsNormalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
    .replace(/(\d+)\s?s\b/g, '$1 segundos').replace(/(\d+)\s?min\b/g, '$1 minutos')
    .replace(/[«»]/g, '').replace(/…/g, '...');
}
const WORD = /[\p{L}\p{N}]+/gu;

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
    this.phraseStarts = new Map(); // worker utterance id → when that phrase started
    this.openPhrases = new Set();  // utterance ids begun whose transcript has not come yet
    this.ducked = false;
    this.bargeTimer = null;
    this.promptKey = null;      // the question/permission currently held in the call
    this.askedAt = null;        // when it reached the user (null: not yet, e.g. it came while hanging up)
    this.awaitCut = false;      // ✕ with an engine without phrase ids: drop transcripts until the recognizer restarts
    this.cutTimer = null;
    this._resetDraft();
  }

  // Capture "aec" confirmed by the window: the microphone no longer hears Claude's own voice.
  setEchoCancelled(value) {
    this.echoCancelled = Boolean(value);
    // Played (even partly) outside echo cancellation (the Windows fallback voice): its echo can still be
    // in the microphone after it ends, so the text echo filter keeps judging it.
    if (!this.echoCancelled && this.playing) this.playing.unfiltered = true;
  }

  // ── Inputs ──────────────────────────────────────────────────────────────

  setCall(call) {
    const previous = this.call?.id || null;
    if ((call?.id || null) !== previous && this.call) this._flushDraft('la llamada ha terminado'); // to the call/session it belonged to
    this.call = call || null;
    if ((call?.id || null) !== previous) {
      // Another call (or none): nothing of the previous one may keep playing or count as echo. What
      // Claude had not said yet is handed back, so it can be heard when the user picks that call up.
      if (previous) {
        const unheard = this._unheardText();
        if (unheard) this.emit('unheard', { callId: previous, text: unheard });
      }
      if (this.playing) this._stopTts();
      this.leaving = false;
      this._resetDraft();
      this.interrupted = null;
      this.pendingSpeak = null;
      this.lastPlayed = null;
      this.noiseCut = null;
      this.lastCut = null;
      this.discardedIds = null;
      this.streamCut = false; // a cut belongs to the call it happened in
      this.replyFrom = 0;     // a round trip never spans a hang-up
      this.streamId = null;
      this.streamOpen = false; // the controller restarts the stream turn when it speaks in this call
      this.promptKey = null;   // a question held in the call reaches the user when they pick it up
      this._watchPending();
      this._clearAudioWait();
    }
    this.kind = call?.interactionKind || null;
    this.turn = !call ? 'idle'
      : RESPONDING.has(call.interactionKind) && call.waiting && !call.awaitingClaude ? 'awaitingUser'
        : call.awaitingClaude ? 'working' : 'informing';
    // A new question or permission: words begun before it reached the user cannot be its answer.
    const asked = this.turn === 'awaitingUser' ? [...(call.messages || [])].reverse().find(m => m.role === 'assistant') : null;
    const key = asked ? `${call.id}:${asked.at}` : null;
    if (key !== this.promptKey) {
      this.promptKey = key;
      this.askedAt = key && !this.leaving ? this.now() : null;
    }
    // A question kept to be said later was answered meanwhile (a button, the terminal): it is not said.
    if (this.pendingSpeak && this.pendingFor && this.pendingFor !== this.promptKey) { this.pendingSpeak = null; this.pendingFor = null; }
    if (call) this._maybeSpeak(call);
    this._ui();
  }

  // A message to say once the user (or Claude's own sentence) is done; a question remembers which one.
  _holdSpeak(text) {
    this.pendingSpeak = text;
    this.pendingFor = this.promptKey;
    if (this.promptKey) this.askedAt = null; // the user has not heard it yet: what they say now is not its answer
    this._watchPending();
  }

  // A kept message is said as soon as nothing holds it any more (also when what held it never reports back).
  _watchPending() {
    if (this.pendingTimer) this.clearTimer(this.pendingTimer);
    this.pendingTimer = null;
    if (!this.pendingSpeak) return;
    this.pendingTimer = this.setTimer(() => {
      this.pendingTimer = null;
      if (!this.pendingSpeak || this.leaving) return;
      if (this._userQuiet() && !(this.playing?.streaming && this.speaking())) this._flushPendingSpeak();
      else this._watchPending();
    }, PENDING_CHECK_MS);
  }

  setMuted(value) {
    if (value && !this.muted) this._flushDraft('micrófono silenciado');
    this.muted = Boolean(value);
    if (this.muted) this._resetDraft();
    // Claude kept a message while the user was talking: muting ends that phrase, so it is said now.
    if (this.pendingSpeak && !this.speaking()) this._flushPendingSpeak();
    this._ui();
  }

  // What Claude had not said when the user left: the rest of what was playing, a message kept until
  // the user finished talking, and what a cut not confirmed as words (a noise, a lone "espera") left.
  _unheardText() {
    const parts = [];
    if (this.playing && !this.playing.ack && !this.playing.idle) parts.push(this._remainder(this.playing));
    else if (this.interrupted && (this.noiseCut || this.lastCut || this.holding)) parts.push(this._remainder(this.interrupted));
    if (this.pendingSpeak) parts.push(this.pendingSpeak);
    return parts.filter(Boolean).join(' ').trim();
  }

  // Recognised words still waiting for the end of the turn are sent now instead of being dropped
  // (hang-up, another call, mute). An unfinished partial is not: it was never a confirmed transcript.
  // The user pressed Colgar / En espera: Claude goes quiet now (what it had not said yet is handed back
  // to be heard later) while the call waits a moment for what the user was still saying.
  leave() {
    if (!this.call) return;
    const callId = this.call.id;
    const unheard = this._unheardText();
    // Leaving first: handing the rest back changes the call, and nothing may start playing again here.
    this.leaving = true;
    if (this.playing) this._stopTts();
    this.pendingSpeak = null;
    if (unheard) {
      // Handed back once: what a pending cut would have resumed is now the call's to say later.
      this.interrupted = null;
      this.noiseCut = null;
      this.lastCut = null;
      this.emit('unheard', { callId, text: unheard });
    }
    this._ui();
  }

  // Colgar / En espera did not happen after all (the call is still the active one).
  cancelLeave() {
    this.leaving = false;
    if (this.promptKey && this.askedAt == null) this.askedAt = this.now(); // a question that came meanwhile is now in front of the user
    this._ui();
  }

  // Resolves once the user is not mid-phrase and no transcript is still coming (or after `ms`): what
  // they said just before hanging up is then in the draft and can be flushed.
  settle(ms = 1500) {
    const pending = () => this.userSpeaking || Boolean(this.partialText) || (this.policy?.pendingFinals || 0) > 0;
    if (!pending()) return Promise.resolve();
    const start = this.now();
    return new Promise((resolve) => {
      const check = () => { if (!pending() || this.now() - start >= ms) resolve(); else this.setTimer(check, 100); };
      this.setTimer(check, 100);
    });
  }

  // The user is about to hang up or step away: what they already said goes to Claude first, while the
  // call still exists (after the hang-up there is no call left to route it through).
  // early: Claude's result or question came while the user was leaving and was not heard, so these
  // words are not an answer to it.
  flushDraft(reason = 'cuelgas', { early = false } = {}) {
    this._flushDraft(reason, early);
    this._ui();
  }

  _flushDraft(reason, early = false) {
    const text = [this.prefix, this.policy ? this.policy.text() : ''].filter(Boolean).join(' ').trim();
    if (!text) return;
    // A lone "espera" / "a ver" only asked Claude for time: leaving the call already does that, and as an
    // answer it would decide a question (a permission denied) the user has not answered.
    if (HOLD_ONLY.test(fold(text))) { this._debug(`${reason}: «${text}» no se envía`); return; }
    this._debug(`${reason}: envío lo que ya habías dicho`);
    this._commit(text, 'voice', { early });
  }

  listening() { return Boolean(this.call) && !this.muted; }

  stt(ev) {
    if (ev.type === 'ready') {
      // A recognizer (re)started: a phrase it was hearing is gone, and so are the transcripts still due.
      if (this.userSpeaking && this.listening()) this._speechEnd({ cancelled: true, utterance: this.utterance });
      this.phraseStarts.clear();
      this.openPhrases.clear();
      this.discardedIds = null;
      this._endCutWait();
      this._lostTranscripts();
      return;
    }
    if (ev.type === 'error') this._lostTranscripts(); // a transcription that failed sends nothing else
    // The recognizer confirms the cut asked by ✕: what it sends from now on was said after it.
    if (ev.type === 'cut' || ev.type === 'listening') this._endCutWait();
    if ((ev.type === 'final' || ev.type === 'rejected') && ev.utterance != null) this.openPhrases.delete(ev.utterance);
    if (!this.listening()) return;
    if (ev.type === 'speech' && ev.state === 'start') this._speechStart(ev);
    else if (ev.type === 'speech' && ev.state === 'end') this._speechEnd(ev);
    else if ((ev.type === 'partial' || ev.type === 'final' || ev.type === 'rejected') && this._discarded(ev)) {
      if (ev.type !== 'partial') this._noWords(ev.utterance);
    } else if (ev.type === 'partial') { this._utteranceStart = this.phraseStarts.get(ev.utterance); this._partial(String(ev.text || '')); }
    else if (ev.type === 'final') { this._utteranceStart = this.phraseStarts.get(ev.utterance); this._final(String(ev.text || ''), typeof ev.confidence === 'number' ? ev.confidence : 1, ev.utterance); }
    else if (ev.type === 'rejected') this._final('', 0, ev.utterance); // the phrase had no words
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
    if (ev.type === 'idle') {
      // A streamed answer played everything it had; Claude is working on the rest (or on a tool).
      cur.idle = true;
      cur.wasQuiet = true;
      cur.idleAt = this.now();
      this._clearAudioWait();
      this._clearBargeTimer();
      if (this.ducked) { this.ducked = false; this.emit('tts', { action: 'unduck' }); }
      if (this.deferredCommit && !this.userSpeaking) { this.deferredCommit = false; this._onDeadline(); }
      if (this.pendingSpeak && this._userQuiet()) this._flushPendingSpeak();
      this._ui();
      return;
    }
    if (ev.type === 'chunk') {
      const resumed = Boolean(cur.wasQuiet); // Claude talks again after a quiet moment
      cur.wasQuiet = false;
      cur.idle = false;
      this._clearAudioWait();
      if (resumed && this.userSpeaking) this._armBarge(); // the user was already talking: weigh it as a barge-in
      if (!cur.chunks.size && !cur.ack) {
        this._metric('tts.first_audio_ms', this.now() - cur.startedAt);
        // The user finished their turn → Claude's voice answers (whole round trip, SPEC §9).
        if (this.replyFrom) this._metric('turn.roundtrip_ms', this.now() - this.replyFrom);
        this.replyFrom = 0;
      }
      cur.chunks.set(ev.seq, String(ev.text || ''));
      cur.current = ev.seq;
    } else if (ev.type === 'end') {
      this._finishTts(Boolean(ev.interrupted));
      if (this.deferredCommit && !this.userSpeaking) { this.deferredCommit = false; this._onDeadline(); }
      // A question that waited for Claude's sentence to finish is asked now.
      if (this.pendingSpeak && this._userQuiet() && !this.playing) this._flushPendingSpeak();
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
    if (this.duckHoldTimer) this.clearTimer(this.duckHoldTimer);
    this.duckHoldTimer = null;
    this.duckedFor = undefined; // this phrase decides now whether Claude stays low
    this.deferredCommit = false; // the user went on talking: the turn is not over
    this.speechStartAt = this.now() - (Number(ev.onset_ms) || 0);
    this.utterance = ev.utterance ?? null;
    this.phraseStartAt = this.speechStartAt; // kept across commits: decides whether a phrase can be echo
    if (ev.utterance != null) {
      this.openPhrases.add(ev.utterance); // until its transcript (or its absence) is known
      this.phraseStarts.set(ev.utterance, this.speechStartAt); // a transcript is judged by its own phrase
      if (this.phraseStarts.size > 50) this.phraseStarts.delete(this.phraseStarts.keys().next().value);
    }
    this.sawPartial = false;
    this._clearHoldTimer();
    this._policy().speechStart(this.now());
    this._arm();
    this._armBarge();
  }

  // With echo cancellation, a voice over Claude lowers it and, if it goes on, stops it.
  _armBarge() {
    if (!this.echoCancelled || !this.speaking() || this.playing.ack) return;
    this._clearBargeTimer();
    this.duckTimer = this.setTimer(() => { this.duckTimer = null; if (this.userSpeaking && this.speaking()) this._duck(); }, DUCK_AFTER_MS);
    // The end of the phrase is reported VAD_TAIL_MS after the voice stops: only a voice that really
    // went on for BARGE_CONFIRM_MS is still "speaking" when this fires.
    this.bargeTimer = this.setTimer(() => { this.bargeTimer = null; if (this.userSpeaking && this.speaking()) this._bargeIn('voz sostenida'); }, BARGE_CONFIRM_MS + VAD_TAIL_MS);
  }

  _speechEnd(ev) {
    this.userSpeaking = false;
    const expectFinal = !ev.cancelled && !this.discardedIds?.has(ev.utterance) && (ev.voiced_ms == null || ev.voiced_ms >= MIN_TRANSCRIBED_MS);
    if (this.bargeTimer) {
      this._clearBargeTimer();
      // A short "para" that lowered Claude stays lowered until its transcript says whether it was words
      // (any word then stops Claude); a sound that will not be transcribed restores the volume now.
      if (this.ducked && expectFinal) this._holdDuck(ev.utterance);
      else this._releaseDuck('ruido breve: Claude sigue hablando');
    }
    this.speechEndAt = this.now() - (Number(ev.silence_ms) || 0);
    this._policy().speechEnd(this.now(), { expectFinal, silenceMs: Number(ev.silence_ms) || 0 });
    this._arm();
    if (!expectFinal) this.openPhrases.delete(ev.utterance);
    if (!expectFinal && this._noiseCutBy(ev.utterance)) this._resumeAfterNoise(); // no transcript will come
    // What Claude kept while the user talked waits for that phrase's transcript (it would cut it).
    if (this.pendingSpeak && this._userQuiet()) this._flushPendingSpeak();
    this._armHold();
  }

  _partial(text) {
    if (this.speaking() || this._inEchoTail()) {
      if (this._isEcho(text, this._utteranceStart)) return; // Claude hearing itself through the speakers
      const words = fold(text).split(' ').filter(Boolean).length;
      if (this.speaking() && (this.ducked ? words >= 1 : contentWords(text).length >= 2)) this._bargeIn('parcial');
    }
    if (!this.partialText) this.partialSince = this.now(); // engines without voice events: when this phrase showed up
    if (!this.sawPartial && this.speechStartAt) this._metric('stt.first_partial_ms', this.now() - this.speechStartAt);
    this.sawPartial = true;
    this.partialText = text;
    this._policy().partial(this.now(), text);
    this._arm();
  }

  _final(text, confidence, utterance = null) {
    this.partialText = '';
    if (this.speechEndAt) this._metric('stt.final_ms', this.now() - this.speechEndAt);
    const policy = this._policy();
    if (!text || confidence < MIN_CONFIDENCE || this._isEcho(text, this._utteranceStart)) {
      this.lowConfidence = Boolean(text) && confidence < MIN_CONFIDENCE;
      if (text) this._debug(this.lowConfidence ? `descarto (confianza ${confidence}): «${text}»` : `eco de Claude: «${text}»`);
      this._noWords(utterance);
      return;
    }
    this.lowConfidence = false;
    // The draft began with the first phrase that brought words. Windows dictation reports a phrase
    // late and without its onset: its first partial, a little earlier.
    if (this.draftStartAt == null) this.draftStartAt = this._utteranceStart ?? (this.partialSince != null ? this.partialSince - DICTATION_LAG_MS : this.now() - DICTATION_LAG_MS);
    this.partialSince = null;
    this.noiseCut = null; // the user really spoke: the cut stands ("sigue" brings Claude back)
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

  // A transcript with no words for the user (noise, echo, a phrase thrown away with ✕): the turn is
  // re-timed without it, and a cut or a lowered voice it caused is undone.
  _noWords(utterance) {
    this._policy().final(this.now(), '', 0);
    this._arm();
    this._armHold();
    if (this._noiseCutBy(utterance)) this._resumeAfterNoise();
    if (this.duckedFor !== undefined && (this.duckedFor == null || utterance == null || this.duckedFor === utterance)) this._releaseDuck('no eran palabras: Claude sigue');
    if (this.pendingSpeak && this._userQuiet()) this._flushPendingSpeak();
  }

  // Nothing of the user's is in flight: not talking, no draft, no transcript still to come.
  _userQuiet() {
    const waiting = (this.policy?.pendingFinals || 0) > 0 && this.now() - (this.speechEndAt || 0) < ADAPTIVE.finalTimeoutMs;
    return !this.userSpeaking && !this._draftText() && !waiting;
  }

  // ── Claude's voice ──────────────────────────────────────────────────────

  // Claude's voice is audible. A streamed answer stays open while Claude works between sentences; with
  // nothing left to play it is not speaking (the user's words are then not an interruption).
  speaking() { return Boolean(this.playing) && !this.playing.idle; }

  _maybeSpeak(call) {
    if (this.leaving) return; // the user is hanging up: nothing new is said (it stays unheard)
    const latest = [...(call.messages || [])].reverse().find(m => m.role === 'assistant');
    if (!latest) return;
    const key = `${call.id}:${latest.at}:${latest.rev || 0}`; // rev: to be said (again) after the user missed it
    if (this.spokenKeys.has(key)) return;
    this.spokenKeys.add(key);
    if (this.spokenKeys.size > 500) this.spokenKeys.delete(this.spokenKeys.values().next().value);
    if (latest.silent) return; // shown in the call, not read (e.g. a result the user already moved past)
    const text = String(latest.speech || latest.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!this._userQuiet()) { this._holdSpeak(text); return; } // never talk over the user (nor before their words arrive)
    // Claude is saying what it wrote before asking: the question comes after that sentence, not over it.
    if (this.playing?.streaming && this.speaking()) { this._holdSpeak(text); return; }
    this._speak(text);
  }

  _speak(text) {
    if (this.leaving) return;
    if (this.playing) this._stopTts();
    this.counter += 1;
    this.playing = { id: `v${this.counter}`, text, chunks: new Map(), current: null, startedAt: this.now(), ack: false, unfiltered: !this.echoCancelled };
    this.interrupted = null;
    this.emit('speak', { id: this.playing.id, text });
  }

  _ack(phrase) {
    if (this.leaving) return;
    if (this.playing) this._stopTts();
    this.counter += 1;
    this.playing = { id: `ack${this.counter}`, text: ACK_TEXT[phrase], chunks: new Map(), current: null, startedAt: this.now(), ack: true };
    this.emit('ack', { id: this.playing.id, phrase });
  }

  // ── Streamed answers (controlled session): Claude talks while it writes ──────
  // The provider feeds speakable sentences (SpeechChunker) as Claude's text streams in. They form one
  // utterance; once the user cuts it, the rest of that turn is kept for "sigue" instead of spoken.

  streamTurnStart() {
    this.noiseCut = null;
    this.streamCut = false;
    this.streamId = null;
    this.streamOpen = true;
  }

  streamSentence(sentence) {
    const text = String(sentence || '').replace(/\s+/g, ' ').trim();
    if (!text || this.leaving) return;
    if (this.streamCut) {
      // Kept for "sigue", never dropped (also when nothing of this turn was playing when it was cut).
      if (this.interrupted) this.interrupted.text = `${this.interrupted.text} ${text}`.trim();
      else this.interrupted = { id: null, text, chunks: new Map(), current: null, startedAt: this.now(), ack: false, streaming: true };
      return;
    }
    if (!this.playing || this.playing.id !== this.streamId) {
      if (this.playing) this._stopTts();
      this.counter += 1;
      this.playing = { id: `s${this.counter}`, text: '', chunks: new Map(), current: null, startedAt: this.now(), ack: false, streaming: true, unfiltered: !this.echoCancelled };
      this.streamId = this.playing.id;
      this.interrupted = null;
      this.emit('speak-stream', { id: this.playing.id, action: 'start' });
    }
    if (this.playing.idle) {
      // Claude talks again: until this sentence plays (or turns out never to), its voice counts as on.
      this.playing.idle = false;
      this._clearAudioWait();
      const p = this.playing;
      this.audioWait = this.setTimer(() => { this.audioWait = null; if (this.playing === p && !p.idle) { p.idle = true; p.idleAt = this.now(); } }, AUDIO_WAIT_MS);
    }
    this.playing.text = `${this.playing.text} ${text}`.trim();
    this.emit('speak-stream', { id: this.playing.id, action: 'append', text });
  }

  _clearAudioWait() {
    if (this.audioWait) this.clearTimer(this.audioWait);
    this.audioWait = null;
  }

  // Each message Claude writes is heard: a cut kept the rest of the previous one for "sigue", not the
  // ones after it (Claude may be answering what the user said when they cut it).
  streamMessageStart() {
    if (this.noiseCut || this.holding || !this._userQuiet()) return;
    this.streamCut = false;
  }

  streamTurnEnd() {
    if (this.playing && this.playing.id === this.streamId) this.emit('speak-stream', { id: this.streamId, action: 'end' });
    this.streamId = null;
    this.streamOpen = false;
  }

  _flushPendingSpeak() {
    if (this.playing?.streaming && this.speaking()) return; // after the sentence Claude is saying
    const text = this.pendingSpeak;
    const question = Boolean(this.pendingFor) && this.pendingFor === this.promptKey;
    this.pendingSpeak = null;
    this.pendingFor = null;
    if (!text) return;
    this._speak(text);
    if (question && this.playing) this.askedAt = this.now(); // from now on the user is answering it
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
    if (this.duckTimer) this.clearTimer(this.duckTimer);
    this.bargeTimer = null;
    this.duckTimer = null;
  }

  _holdDuck(utterance) {
    this.duckedFor = utterance ?? null;
    if (this.duckHoldTimer) this.clearTimer(this.duckHoldTimer);
    // Never stays low if the transcript does not come.
    this.duckHoldTimer = this.setTimer(() => { this.duckHoldTimer = null; this._releaseDuck('sin transcripción: Claude sigue'); }, DUCK_HOLD_MS);
  }

  _releaseDuck(why) {
    if (this.duckHoldTimer) this.clearTimer(this.duckHoldTimer);
    this.duckHoldTimer = null;
    this.duckedFor = undefined;
    if (!this.ducked) return;
    this.ducked = false;
    this.emit('tts', { action: 'unduck' });
    this.emit('failure', 'false_speech_start');
    if (why) this._debug(why);
  }

  _bargeIn(reason) {
    this._clearBargeTimer();
    if (this.duckHoldTimer) this.clearTimer(this.duckHoldTimer);
    this.duckHoldTimer = null;
    this.duckedFor = undefined;
    this.ducked = false;
    if (!this.playing) return;
    this._debug(`interrumpe a Claude (${reason})`);
    if (this.speechStartAt) this._metric('bargein.stop_ms', this.now() - this.speechStartAt);
    if (!this.playing.ack) this.interrupted = { ...this.playing, chunks: new Map(this.playing.chunks) };
    if (this.playing.streaming && this.kind !== 'permission' && this.kind !== 'ask') this.streamCut = true;
    // Until the phrase that cut Claude turns out to have words, the cut may be a click or a key.
    this.noiseCut = reason === 'final' || !this.interrupted ? null
      : { interrupted: this.interrupted, utterance: this.utterance, streaming: Boolean(this.playing.streaming) };
    // Undone if the user throws away (✕) the words that cut Claude before they are sent.
    this.lastCut = this.interrupted ? { interrupted: this.interrupted, utterance: this.utterance, streaming: Boolean(this.playing.streaming) } : null;
    this._stopTts();
  }

  _noiseCutBy(utterance) {
    const cut = this.noiseCut;
    return Boolean(cut) && (cut.utterance == null || utterance == null || cut.utterance === utterance);
  }

  // What cut Claude had no words (keys, clicks, a chair, music, a garbled guess): a person on the
  // phone would just go on, so Claude picks up again from the sentence it was cut in.
  _resumeAfterNoise() {
    const cut = this.noiseCut;
    this.noiseCut = null;
    // Anything that happened since (new words, a new message, "sigue") wins over resuming.
    if (!cut || this.interrupted !== cut.interrupted || this.speaking() || this.userSpeaking || this._draftText()) return;
    const rest = this._remainder(this.interrupted);
    this.interrupted = null;
    if (!rest) return;
    if (this.leaving) { // the user is hanging up: it is said when they pick the call up again
      if (this.call) this.emit('unheard', { callId: this.call.id, text: rest });
      return;
    }
    this.emit('failure', 'false_speech_start');
    this._debug('ruido sin palabras: Claude sigue hablando');
    this._resume(rest, cut.streaming);
  }

  _stopTts() {
    if (this.playing) this.stopping = { id: this.playing.id, at: this.now() };
    this.emit('tts', { action: 'stop', id: this.playing?.id || null });
    this._finishTts(true);
  }

  _finishTts(interrupted) {
    this._clearBargeTimer();
    this.ducked = false;
    if (!this.playing) return;
    this.lastPlayed = { ...this.playing, endedAt: this.now(), interrupted };
    this.playing = null;
  }

  // Claude's voice went quiet a moment ago (finished, or a streamed answer waiting for Claude's next words).
  _quietRef() {
    if (this.playing?.idle) return { ref: this.playing, at: this.playing.idleAt ?? this.now() };
    if (!this.playing && this.lastPlayed) return { ref: this.lastPlayed, at: this.lastPlayed.endedAt };
    return null;
  }

  _inEchoTail() {
    const q = this._quietRef();
    return Boolean(q) && this.now() - q.at <= ECHO_TAIL_MS;
  }

  // Without headphones Claude's voice reaches the microphone: a recognition whose words mostly come
  // from what Claude is (or was just) saying is its own echo.
  // `startedAt`: when the phrase this transcript belongs to began (worker utterance id), if known.
  _isEcho(text, startedAt = this.phraseStartAt) {
    const audible = this.speaking() ? this.playing : null;
    const quiet = audible ? null : this._quietRef();
    const ref = audible || (quiet && this.now() - quiet.at <= ECHO_TAIL_MS ? quiet.ref : null);
    if (!ref) return false;
    if (this.echoCancelled && !ref.unfiltered) return false; // the microphone no longer hears Claude
    // Only voice that started while Claude was playing can be its echo: a phrase that began before
    // Claude started talking is the user's even if it repeats Claude's words.
    if (startedAt != null && startedAt < ref.startedAt - 150) return false;
    // A phrase that began after Claude went quiet is the user's, even if it repeats Claude's words
    // ("¿Supabase o Neon?" → "Neon"). Only voice that started during playback can be its echo.
    if (!audible && startedAt != null && startedAt > quiet.at + 150) return false;
    const heard = contentWords(text);
    if (!heard.length) return Boolean(audible);
    const spoken = new Set(contentWords(ref.text));
    return heard.filter(w => spoken.has(w)).length / heard.length >= 0.6;
  }

  // Text from the sentence that was playing when the user cut in, to the end of the message.
  _remainder(utt) {
    if (!utt) return '';
    const cut = utt.chunks.get(utt.current);
    let at = cut ? utt.text.indexOf(cut) : -1;
    if (cut && at < 0) {
      // The voice reports its normalized sentence ("30 s" → "30 segundos", «» removed): found there, then
      // mapped back to the original text by counting the words before it.
      const norm = ttsNormalize(utt.text);
      const p = norm.indexOf(ttsNormalize(cut));
      if (p >= 0) {
        const n = (norm.slice(0, p).match(WORD) || []).length;
        const words = [...utt.text.matchAll(WORD)];
        at = n < words.length ? words[n].index : -1;
      }
    }
    return (at >= 0 ? utt.text.slice(at) : utt.text).trim();
  }

  _localIntent(text) {
    const t = fold(text);
    // "Sí, adelante" to a permission or a question is its answer, even if it cut the question short.
    const deciding = this.turn === 'awaitingUser' && (this.kind === 'permission' || this.kind === 'ask');
    if (RESUME.test(t) && this.interrupted && !deciding) {
      const { streaming } = this.interrupted;
      const rest = this._remainder(this.interrupted);
      this.interrupted = null;
      if (rest) { this.emit('local', { intent: 'resume' }); this._resume(rest, streaming); return true; }
    }
    if (REPEAT.test(t) && (this.interrupted || this.lastPlayed)) {
      const source = this.interrupted || (this.lastPlayed && !this.lastPlayed.ack ? this.lastPlayed : null);
      const again = this.interrupted ? this._remainder(this.interrupted) : source?.text;
      const streaming = Boolean(source?.streaming);
      this.interrupted = null;
      if (again) { this.emit('local', { intent: 'repeat' }); this._resume(again, streaming); return true; }
    }
    return false;
  }

  // Claude goes on from where it was cut: inside the streamed answer if it is still being written (so
  // the sentences still to come follow it), as a message otherwise.
  _resume(text, streaming) {
    this.streamCut = false;
    if (streaming && this.streamOpen) {
      if (this.playing && !this.playing.streaming) this._stopTts();
      this.streamSentence(text);
    } else this._speak(text);
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
    if (this.speaking() && !this.playing.ack) { this.deferredCommit = true; this._debug('fin de turno aplazado: Claude habla'); return; } // never answer while Claude is still talking
    const spoken = this.policy ? this.policy.take() : '';
    const text = [this.prefix, spoken].filter(Boolean).join(' ').trim();
    if (!text) return this._ui();
    // "Sigue" / "repite" (also after "espera…": the hold was for that) are about Claude's own voice.
    if (this._localIntent(this.prefix && this.holding ? spoken : text)) { this._resetDraft(); return this._ui(); }
    if (HOLD_ONLY.test(fold(text))) {
      this._debug(`espera: «${text}»`);
      // "Espera…": Claude stops and listens; the words stay as the start of what comes next.
      this.prefix = text;
      this.holding = true;
      if (this.playing && !this.playing.ack && !this.interrupted) this.interrupted = { ...this.playing, chunks: new Map(this.playing.chunks) };
      if (this.streamOpen) this.streamCut = true; // what Claude goes on writing waits for "sigue"
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

  _commit(text, source, { early: unheard = false } = {}) {
    this.noiseCut = null; // a new turn: an old noise must not bring back what Claude was saying
    this.lastCut = null;  // the words that cut Claude were sent: the cut stands
    // Words begun before a question or permission reached the user were not said to it: they go to Claude
    // as something to take into account, and the question is still waiting for its answer.
    const early = unheard || (source === 'voice' && this.turn === 'awaitingUser' && (this.kind === 'permission' || this.kind === 'ask')
      && (this.askedAt == null || (this.draftStartAt != null && this.draftStartAt < this.askedAt)));
    const route = this.turn === 'awaitingUser' && !early ? 'answer' : 'steer';
    const commit = {
      callId: this.call?.id || null,
      sessionId: this.call?.sessionId || null,
      text,
      route,
      early,
      urgency: route === 'steer' ? classifyUrgency(text) : null,
      kind: this.kind,
      source,
    };
    if (source === 'voice' && this.speechEndAt) this._metric('turn.endpoint_ms', this.now() - this.speechEndAt);
    this.replyFrom = source === 'voice' && this.speechEndAt ? this.speechEndAt : this.now();
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
  // "✕" on what was heard: noise taken for words, or the user starts over. It never reaches Claude,
  // nor does the phrase still being transcribed; what is said next starts a fresh turn. If those words
  // had cut Claude, Claude picks up again where it was.
  // `cutting`: the recognizer was told to drop the phrase it is hearing and will confirm it ('cut', or
  // 'listening' once Windows dictation restarts). Until then, transcripts without a phrase id are from
  // before the ✕ and are dropped too.
  discardDraft({ cutting = false } = {}) {
    this._resetDraft();
    this.discardedIds = new Set(this.openPhrases); // phrases begun and not transcribed yet
    this._endCutWait();
    if (cutting) {
      this.awaitCut = true;
      this.cutTimer = this.setTimer(() => { this.cutTimer = null; this.awaitCut = false; }, CUT_WAIT_MS);
    }
    this._debug('borras lo escuchado');
    if (this.ducked || this.duckedFor !== undefined) this._releaseDuck(null);
    if (this.lastCut && this.interrupted === this.lastCut.interrupted && !this.speaking()) {
      this.noiseCut = this.lastCut;
      this._resumeAfterNoise();
    }
    this.lastCut = null;
    // Claude said something while the user was talking (kept until they finished): it is heard now.
    if (this.pendingSpeak && this._userQuiet()) this._flushPendingSpeak();
    this._ui();
  }

  // A transcript (or partial) of a phrase the user threw away with ✕.
  _discarded(ev) {
    if (ev.utterance != null) {
      const hit = Boolean(this.discardedIds?.has(ev.utterance));
      if (hit && ev.type !== 'partial') this.discardedIds.delete(ev.utterance);
      return hit;
    }
    return this.awaitCut;
  }

  // Transcripts still expected will not come (recognizer restarted or failed): nothing waits for them.
  _lostTranscripts() {
    if (!this.policy?.pendingFinals) return;
    this.policy.pendingFinals = 0;
    this.policy.final(this.now(), '', 0);
    this._arm();
    if (this.pendingSpeak && this._userQuiet()) this._flushPendingSpeak();
  }

  _endCutWait() {
    if (this.cutTimer) this.clearTimer(this.cutTimer);
    this.cutTimer = null;
    this.awaitCut = false;
  }

  clearDraft() {
    this._resetDraft();
    this._ui();
  }

  // Acknowledge only what deserves it: never after "para"/"espera", "un momento" before a clarification.
  committed({ ok, route, urgency, text, clarification, stream }) {
    // A controlled session answers within a second or two by voice: no acknowledgement needed.
    if (!ok || this.muted || stream) return;
    let phrase = 'vale';
    if (route === 'steer' && urgency === 'interrupt') phrase = null;
    else if (route === 'answer' && (clarification || /\?\s*$/.test(String(text || '')))) phrase = 'momento';
    if (phrase) this._ack(phrase);
  }

  _resetDraft() {
    if (this.endpointTimer) this.clearTimer(this.endpointTimer);
    this.endpointTimer = null;
    this._clearHoldTimer();
    this._clearBargeTimer(); // the phrase that was going to cut Claude is no longer part of anything
    this.draftStartAt = null;
    this.partialSince = null;
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

module.exports = { VoiceConversation, classifyUrgency, contentWords, HOLD_MS, ACK_TEXT, BARGE_CONFIRM_MS, DUCK_AFTER_MS, VAD_TAIL_MS };
