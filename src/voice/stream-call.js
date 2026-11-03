'use strict';
// StreamCallController: a "controlled" call (Voice First §6). The user calls Claude from AgentCall;
// AgentCall drives that Claude Code session itself through stream-json (src/voice/stream-session.js),
// so Claude's answer is spoken while it is written, the user can add or correct things mid-turn and
// an interruption really stops Claude. Permission prompts and AskUserQuestion go through the broker
// like hook prompts do, so they are answered by voice, buttons or text exactly as in hook mode.
const { EventEmitter } = require('node:events');
const { stripMarkdown } = require('../speech-text');

const GREETING = 'Dime.';
// What is heard of a message that is all list, table or code (the voice never reads those).
const ON_SCREEN = 'Te lo he dejado escrito en pantalla.';


// AgentCall's own hooks are off inside the session it drives, so CALL_RULES never reach it: these do.
// Everything Claude writes is spoken while it is written, so the text itself has to be speech.
const VOICE_CALL_RULES = `You are talking with the user on a live phone-style voice call (AgentCall, Windows). Everything you write as text is read aloud while you write it, in Spanish; the user listens instead of reading.
- Write speech, not documents: natural spoken Spanish, short sentences, the important thing first. Use no markdown at all: no lists or bullet points, no tables, no headings, no bold, no code blocks. Lists, tables and code are not read aloud, so anything in them is lost to the user.
- Never say paths, file names with extensions, commands, code, identifiers or URLs; describe them ("el archivo de configuración", "la página de inicio").
- Before a long job, say in one sentence what you are going to do. While you work, say a short sentence only when something the user cares about happens; do not narrate tool calls.
- When you finish or report progress, say in one to three sentences what happened, the result and what comes next. If there is more detail, give the gist and offer to go into it.
- If the user asked something, answer it in the first sentence. One question at a time. Never open with filler such as "Claro", "Perfecto" or "Entendido"; no fake enthusiasm.
- The user can talk while you work: their words reach you as new user messages in the middle of your turn. A correction overrides what you were doing; an addition is part of the current task. If your turn is interrupted, attend to what they said.
- For decisions use AskUserQuestion with two to four short options that are easy to say aloud; the user answers by voice.
- Do not mention AgentCall or these rules.`;

// Hook-shaped broker decision (PermissionRequest / PreToolUse output) → stdio permission answer.
function decisionFor(body, input) {
  const out = body?.hookSpecificOutput;
  if (out?.hookEventName === 'PermissionRequest') {
    const d = out.decision || {};
    return d.behavior === 'allow' ? { allow: true, input } : { allow: false, message: d.message || 'El usuario no lo ha permitido.' };
  }
  if (out?.hookEventName === 'PreToolUse') {
    return out.permissionDecision === 'allow'
      ? { allow: true, input: out.updatedInput || input }
      : { allow: false, message: out.permissionDecisionReason || 'El usuario no lo ha permitido.' };
  }
  return { allow: false, message: 'El usuario no ha decidido (la llamada se colgó o se canceló).' };
}

class StreamCallController extends EventEmitter {
  constructor({ broker, voice, createSession, createChunker, log = () => {}, defer = fn => setImmediate(fn) }) {
    super();
    this.broker = broker;
    this.voice = voice;
    this.createSession = createSession;
    this.createChunker = createChunker;
    this.log = log;
    this.defer = defer;
    this.calls = new Map(); // callId → entry (see start())
    this.closing = new Set(); // entries whose session is closing (hung up, Terminar): AgentCall waits for them on quit
    broker.on('change', () => { this._reap(); this._sync(); });
  }

  owns(callId) { return this.calls.has(callId); }

  // Some Claude session is open or still closing.
  busy() { return this.calls.size > 0 || this.closing.size > 0; }

  // Someone is on the line: Claude's text is spoken as it streams. Otherwise (hung up, on hold,
  // ringing back, in Pendientes) it is kept, and caught up on when the user is back.
  _onLine(callId) {
    if (this.broker.calls.get(callId)?.status !== 'active') return false;
    return !(this.voice.leaving && this.voice.call?.id === callId); // pressing Colgar: already gone
  }

  async start({ cwd, resume = null }) {
    // That conversation is already open in a call (hung up, on hold): back to it. A second process on
    // the same conversation would split it in two.
    for (const [callId, e] of this.calls) {
      if (resume && !e.ended && e.session.sessionId === resume) {
        this.broker.answer(callId);
        return this.broker.calls.get(callId);
      }
    }
    const session = this.createSession({ cwd, resume, appendSystemPrompt: VOICE_CALL_RULES });
    // Its own plugin hooks must never ring (whatever /saul stored for a resumed session).
    this.broker.driveSession(session.sessionId);
    try {
      await session.start();
    } catch (err) {
      this.broker.releaseSession(session.sessionId);
      throw err;
    }
    const call = this.broker.openStreamCall({ sessionId: session.sessionId, cwd });
    const entry = {
      session, cwd, chunker: null, ended: false,
      messages: new Map(),  // uuid → call message of something the user said while Claude worked
      urgent: 0,            // corrections being sent (interrupt, then send): Claude is not done yet
      prompt: null,         // request id of the prompt asked in the call; others wait in `prompts`
      prompts: [],
      turnOpen: false,
      voiceTurn: false,     // the voice has a stream turn open for this call
      wasOnLine: this._onLine(call.id),
      offline: [],          // sentences of the current message written while nobody listened
      msgMissed: false,     // part of the current message was not heard
      missed: [],           // speech of this turn's messages nobody heard
      cutRest: '',          // what the user left unheard of the message being written (said on picking up)
      turnMsgs: [],         // call messages of this turn
      msgSpoke: 0,          // sentences the current message gave to the voice
      lastMsgSpoke: 0,      // … and the last finished one
      promptCall: null,     // broker call holding the prompt asked (it may not be this call)
      promptedMsg: false,   // what was missed of the current message went in front of a question
    };
    this.calls.set(call.id, entry);
    this._bind(call.id, entry);
    this.broker.addCallMessage(call.id, { role: 'assistant', text: GREETING, kind: 'greeting' });
    this.log(`Llamada controlada ${session.sessionId.slice(0, 8)} en ${cwd}${resume ? ' (continúa)' : ''}`);
    return call;
  }

  // The user said (or typed) something in the call while no prompt is held. Idle Claude: a new turn.
  // Busy Claude: an addition joins the turn at the next tool boundary; a correction interrupts first.
  say(callId, text, urgency = 'queue') {
    const entry = this.calls.get(callId);
    if (!entry || entry.ended) return { ok: false, error: 'La sesión de Claude ya no está abierta.' };
    const { session } = entry;
    const busy = Boolean(session.busy);
    const urgent = busy && urgency === 'interrupt';
    let sent;
    if (urgent) entry.urgent += 1; // before sending: the interrupt's own turn-end comes at once
    try {
      sent = urgent ? session.sendUrgent(text) : session.send(text);
    } catch (err) {
      if (urgent) entry.urgent -= 1;
      this.log(`No se pudo enviar a Claude: ${err?.message || err}`);
      return { ok: false, error: 'No se ha podido enviar a Claude.' };
    }
    const msg = this.broker.addCallMessage(callId, { role: 'user', text, kind: busy ? 'queued' : 'answer', urgency, delivered: !busy });
    // Claude has work from now on, before its turn even starts: hanging up now must not end the call.
    this.broker.setStreamBusy(callId, true);
    const track = uuid => { if (uuid && busy) entry.messages.set(uuid, msg); };
    if (urgent) {
      Promise.resolve(sent).then(
        (uuid) => { entry.urgent -= 1; track(uuid); this._idleCheck(callId, entry); },
        (err) => { entry.urgent -= 1; this._failed(callId, entry, err); },
      );
    } else track(sent);
    return { ok: true, route: busy ? 'steer' : 'answer', stream: true, queued: busy };
  }

  _bind(callId, entry) {
    const { session } = entry;
    session.on('turn-start', () => {
      this.broker.setStreamBusy(callId, true);
      entry.chunker = this.createChunker();
      Object.assign(entry, { turnOpen: true, offline: [], msgMissed: false, missed: [], cutRest: '', turnMsgs: [], msgSpoke: 0, lastMsgSpoke: 0, promptedMsg: false });
      if (this._onLine(callId)) this._catchUp(callId, entry);
    });
    // Each assistant message (before and after every tool) is its own text, heard whole: the end of one
    // is said when it is complete, so the answer after a tool is not glued to it or lost.
    session.on('assistant-start', () => {
      if (entry.chunker) this._finishMessage(callId, entry);
      entry.inMessage = true;
      entry.msgSpoke = 0;
      entry.promptedMsg = false;
      entry.chunker = this.createChunker();
      if (this._onLine(callId) && entry.voiceTurn) this.voice.streamMessageStart();
    });
    session.on('text', ({ delta }) => {
      if (!entry.chunker) return;
      this._say(callId, entry, entry.chunker.push(delta), true);
    });
    session.on('assistant-message', ({ text, aborted }) => {
      if (!aborted) this._finishMessage(callId, entry);
      entry.inMessage = false;
      const prompted = entry.promptedMsg;
      entry.promptedMsg = false;
      if (!text || aborted) return;
      entry.lastMsgSpoke = entry.msgSpoke; // (a message with only a tool call says nothing and is not the answer)
      // Kept in the call, not read again: it was spoken while streamed, or it is caught up on later.
      const msg = this.broker.addCallMessage(callId, { role: 'assistant', text, speech: '', silent: true, kind: 'stream' });
      if (msg) entry.turnMsgs.push(msg);
      // What was missed of it already went in front of a question: not said a second time.
      if (!prompted && (entry.msgMissed || !this._onLine(callId))) entry.missed.push(this._speechOf(text));
      entry.offline = [];
      entry.msgMissed = false;
      entry.cutRest = ''; // the whole message is in `missed` now
    });
    session.on('turn-end', ({ aborted, isError, result } = {}) => {
      if (!aborted && entry.chunker) this._finishMessage(callId, entry); // a message that never reported its end
      const last = entry.turnMsgs.at(-1);
      // An answer that was all list, table or code is never silent.
      if (!aborted && last && !entry.lastMsgSpoke) this._say(callId, entry, [ON_SCREEN]);
      entry.chunker = null;
      entry.turnOpen = false;
      entry.inMessage = false;
      if (isError && !aborted) this._turnFailed(callId, entry, result);
      // A message the user sent meanwhile starts the next turn at once: Claude's voice goes on in the same
      // utterance instead of the next turn cutting what is still being heard.
      const more = Boolean(entry.session.busy) && !entry.ended;
      if (!more) this._endVoiceTurn(callId, entry);
      // Nobody heard how it ended: the last message is what the user hears on picking up.
      const end = entry.turnMsgs.at(-1);
      if (!this._onLine(callId) && end && (entry.missed.length || entry.msgMissed || entry.offline.length || entry.cutRest || end.kind === 'error')) {
        end.silent = false;
        if (end.kind !== 'error') end.speech = this._speechOf(end.text);
        end.rev = (end.rev || 0) + 1;
        this.broker.messagesChanged(callId);
      }
      Object.assign(entry, { offline: [], msgMissed: false, missed: [], cutRest: '', turnMsgs: [] });
      this._idleCheck(callId, entry);
    });
    session.on('message', ({ uuid, state }) => {
      const msg = entry.messages.get(uuid);
      if (msg && (state === 'started' || state === 'completed')) {
        msg.delivered = true;
        entry.messages.delete(uuid);
        this.broker.messagesChanged(callId);
      }
      // A message that ends without a turn (or is cancelled) must not leave the call "working".
      if (!entry.turnOpen) this._idleCheck(callId, entry);
    });
    session.on('permission', (p) => this._permission(callId, entry, p));
    // Claude withdrew a request (e.g. after an interruption): the call stops asking for it.
    session.on('permission-cancelled', ({ requestId } = {}) => {
      if (!requestId) return;
      if (entry.prompt === requestId) {
        entry.prompt = null;
        this.broker.cancel(entry.promptCall || callId);
        entry.promptCall = null;
        this._nextPrompt(callId, entry);
      } else {
        entry.prompts = entry.prompts.filter(q => q.requestId !== requestId);
      }
    });
    session.on('exit', () => {
      if (entry.ended) return;
      this._endVoiceTurn(callId, entry);
      entry.ended = true;
      entry.prompts = [];
      this.broker.setStreamBusy(callId, false);
      this.broker.streamEnded(callId);
      // Said, not only shown: the user may be on the line waiting for Claude.
      this.broker.addCallMessage(callId, { role: 'assistant', text: 'Mi sesión se ha cerrado. Cuelga cuando quieras.', kind: 'note' });
      this.broker.ringStreamCall(callId); // hung up while it worked: the user should know
    });
    session.on('error', err => this.log(`Sesión controlada: ${err?.message || err}`));
  }

  // The user left the call while Claude was still saying something: the rest is caught up on (turn
  // still running) or said when they pick the call up again.
  // done: the part of it that belongs to messages Claude already finished.
  unheard(callId, text, { done = '', question = false } = {}) {
    const entry = this.calls.get(callId);
    if (!entry || (!text && !done && !question)) return;
    const call = this.broker.calls.get(callId);
    // A question cut off or not asked yet: it is asked again whole when the user is back, after what
    // Claude said before it and the user did not hear.
    if (call?.responder && !call.resolved) {
      const asked = [...call.messages].reverse().find(m => m.role === 'assistant');
      if (asked) {
        asked.baseSpeech ??= asked.speech || asked.text;
        const before = [done, text].filter(Boolean).join(' ');
        asked.speech = before ? `${before} ${asked.baseSpeech}` : asked.baseSpeech;
        asked.rev = (asked.rev || 0) + 1;
        this.broker.messagesChanged(callId);
      }
      return;
    }
    if (entry.turnOpen) {
      if (done) entry.missed.push(done);
      if (!text) return;
      // Still being written: the whole message is caught up on once it ends (no half repeated); if the user
      // is back before that, from where they left it.
      if (entry.inMessage) { entry.msgMissed = true; entry.cutRest = text; }
      else entry.missed.push(text);
      return;
    }
    const last = call && [...call.messages].reverse().find(m => m.role === 'assistant');
    if (!last) return;
    Object.assign(last, { silent: false, speech: [done, text].filter(Boolean).join(' '), rev: (last.rev || 0) + 1 });
    this.broker.messagesChanged(callId);
  }

  // Claude's sentences: spoken when someone is on the line, kept for the catch-up otherwise.
  _say(callId, entry, sentences, fromMessage = false) {
    if (!sentences.length) return;
    if (fromMessage) entry.msgSpoke += sentences.length;
    if (this._onLine(callId)) {
      this._catchUp(callId, entry);
      for (const sentence of sentences) this.voice.streamSentence(sentence);
    } else {
      entry.offline.push(...sentences);
      entry.msgMissed = true;
    }
  }

  // The user is (back) on the line during a turn: what they missed of it first (the last message they
  // did not hear and the part of the current one written meanwhile), then Claude goes on live.
  _catchUp(callId, entry) {
    if (!entry.turnOpen) return;
    // A question is being asked in the call: it is not cut (what was missed went in front of it).
    const call = this.broker.calls.get(callId);
    if (call?.responder && !call.resolved) return;
    if (!entry.voiceTurn) {
      this.voice.streamTurnStart();
      entry.voiceTurn = true;
    }
    const parts = this._missedParts(entry);
    entry.msgMissed = false;
    for (const part of parts) this.voice.streamSentence(part);
  }

  // What the user did not hear of this turn, in order (taken: it is about to be said).
  _missedParts(entry) {
    const parts = [...entry.missed.slice(-3), ...(entry.cutRest ? [entry.cutRest] : []), ...entry.offline];
    entry.missed = [];
    entry.cutRest = '';
    entry.offline = [];
    return parts;
  }

  // What is heard of a message caught up on later: what the voice would have said live, or, if that is
  // nothing (all list, table or code), that it is on screen.
  _speechOf(text) {
    const c = this.createChunker();
    return stripMarkdown([...c.push(String(text || '')), c.finish()].filter(Boolean).join(' ')).trim() || ON_SCREEN;
  }

  // The end of a message (its last sentence, or a closing question) once it is complete.
  _finishMessage(callId, entry) {
    const rest = entry.chunker?.finish();
    if (rest) this._say(callId, entry, [rest], true);
  }

  _endVoiceTurn(callId, entry) {
    if (entry.voiceTurn && this._onLine(callId)) this.voice.streamTurnEnd();
    entry.voiceTurn = false;
  }

  // The turn ended in an error (API overloaded, usage limit, prompt too long): the user hears it.
  _turnFailed(callId, entry, result) {
    const detail = String(result || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    this.log(`Turno con error: ${detail || '(sin detalle)'}`);
    const msg = this.broker.addCallMessage(callId, {
      role: 'assistant', kind: 'error',
      text: `Me he detenido por un error${detail ? `: ${detail}` : '.'}`,
      speech: 'Me he detenido por un error. Repítemelo o prueba en un rato.',
    });
    if (msg) entry.turnMsgs.push(msg);
  }

  // Picked up again mid-turn (or stepped away): the voice follows. Deferred so the voice has already
  // switched to this call (main's own broker listener) before anything is spoken in it.
  _sync() {
    for (const [callId, entry] of this.calls) {
      const on = this._onLine(callId);
      if (on && !entry.wasOnLine && entry.turnOpen) this.defer(() => { if (this._onLine(callId)) this._catchUp(callId, entry); });
      if (!on) entry.voiceTurn = false;
      entry.wasOnLine = on;
    }
  }

  // Claude has nothing left to do: the call says so, and rings if the user is away.
  _idleCheck(callId, entry) {
    if (entry.ended || entry.turnOpen || entry.urgent > 0 || entry.session.busy) return;
    this._endVoiceTurn(callId, entry); // a queued message that never became a turn
    this.broker.setStreamBusy(callId, false);
    this.broker.ringStreamCall(callId);
  }

  // Claude can ask several things at once (parallel tools): one is asked in the call at a time.
  _permission(callId, entry, p) {
    // The conversation was ended (Terminar) while Claude still ran: nobody will answer.
    if (entry.ended) { entry.session.deny(p.requestId, 'La llamada ha terminado.'); return; }
    if (entry.prompt) { entry.prompts.push(p); return; }
    entry.prompt = p.requestId;
    const payload = { session_id: entry.session.sessionId, cwd: entry.cwd, tool_name: p.toolName, tool_input: p.input || {} };
    const responder = (body) => {
      const d = decisionFor(body, p.input);
      if (d.allow) entry.session.allow(p.requestId, d.input);
      else entry.session.deny(p.requestId, d.message);
      if (entry.prompt === p.requestId) {
        entry.prompt = null;
        entry.promptCall = null;
        this._nextPrompt(callId, entry);
      }
      return true;
    };
    // 'on': these prompts belong to this call (the session's own plugin hooks are off).
    const handled = p.toolName === 'AskUserQuestion'
      ? this.broker.receiveAskUser(payload, responder, 'on')
      : this.broker.receivePermission(payload, responder, 'on');
    if (handled) entry.promptCall = handled.id;
    if (handled && !this._onLine(callId)) {
      // Nobody on the line: the question will be the first thing heard, so what Claude said before it
      // (and nobody heard) goes in front of it rather than cutting it later.
      const msg = handled.messages?.at(-1);
      if (msg && (entry.missed.length || entry.cutRest || entry.offline.length)) {
        if (entry.inMessage && (entry.msgMissed || entry.offline.length || entry.cutRest)) entry.promptedMsg = true;
        msg.speech = `${this._missedParts(entry).join(' ')} ${msg.speech || msg.text || ''}`.trim();
        entry.msgMissed = false;
      }
    }
    if (!handled) {
      // Never leave Claude waiting for an answer nobody can give.
      this.log(`Permiso ${p.toolName} sin llamada: denegado`);
      entry.prompt = null;
      entry.session.deny(p.requestId, 'AgentCall no ha podido preguntárselo al usuario.');
      this._nextPrompt(callId, entry);
    }
  }

  _nextPrompt(callId, entry) {
    if (entry.prompt || entry.ended || !entry.prompts.length) return;
    // After the broker has finished with the previous answer.
    this.defer(() => {
      if (entry.prompt || entry.ended) return;
      const next = entry.prompts.shift();
      if (next) this._permission(callId, entry, next);
    });
  }

  _failed(callId, entry, err) {
    this.log(`No se pudo enviar a Claude: ${err?.message || err}`);
    this.broker.addCallMessage(callId, { role: 'assistant', text: 'No me ha llegado lo último. Repítelo o escríbelo.', kind: 'note' });
    this._idleCheck(callId, entry);
  }

  // A controlled call that is no longer in the broker (hung up while idle, Terminar) closes its Claude
  // session. Its own hooks stay off until the process is gone.
  _reap() {
    for (const [callId, entry] of this.calls) {
      if (this.broker.calls.has(callId)) continue;
      this.calls.delete(callId);
      entry.ended = true;
      this._close(entry);
    }
  }

  _close(entry) {
    if (entry.closed) return entry.closed;
    this.closing.add(entry);
    entry.closed = Promise.resolve()
      .then(() => entry.session.close())
      .catch(err => this.log(`Cerrar sesión: ${err?.message || err}`))
      .finally(() => {
        this.closing.delete(entry);
        this.broker.releaseSession(entry.session.sessionId);
      });
    return entry.closed;
  }

  // AgentCall is quitting. A Claude left running unattended would go on using tools, so what does not
  // close in time is killed.
  async closeAll({ timeoutMs = 5000 } = {}) {
    const all = [...this.calls.values(), ...this.closing];
    this.calls.clear();
    for (const e of all) e.ended = true;
    const closed = Promise.all(all.map(e => this._close(e)));
    let timer;
    await Promise.race([closed, new Promise(r => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
    for (const e of all) {
      const { child } = e.session;
      if (!child || e.session.exitInfo) continue;
      try { await Promise.race([Promise.resolve(e.session.killTree?.(child.pid, child)), new Promise(r => setTimeout(r, 2000))]); } catch {}
      try { child.kill(); } catch {}
    }
  }
}

module.exports = { StreamCallController, decisionFor, GREETING, VOICE_CALL_RULES };
