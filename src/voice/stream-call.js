'use strict';
// StreamCallController: a "controlled" call (Voice First §6). The user calls Claude from AgentCall;
// AgentCall drives that Claude Code session itself through stream-json (src/voice/stream-session.js),
// so Claude's answer is spoken while it is written, the user can add or correct things mid-turn and
// an interruption really stops Claude. Permission prompts and AskUserQuestion go through the broker
// like hook prompts do, so they are answered by voice, buttons or text exactly as in hook mode.
const { EventEmitter } = require('node:events');
const { toSpeech } = require('../speech-text');

const GREETING = 'Dime.';

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
    broker.on('change', () => { this._reap(); this._sync(); });
  }

  owns(callId) { return this.calls.has(callId); }

  // Someone is on the line: Claude's text is spoken as it streams. Otherwise (hung up, on hold,
  // ringing back, in Pendientes) it is kept, and caught up on when the user is back.
  _onLine(callId) { return this.broker.calls.get(callId)?.status === 'active'; }

  async start({ cwd, resume = null }) {
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
      turnMsgs: [],         // call messages of this turn
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
      Object.assign(entry, { turnOpen: true, offline: [], msgMissed: false, missed: [], turnMsgs: [] });
      if (this._onLine(callId)) this._catchUp(callId, entry);
    });
    // Each assistant message (before and after every tool) is its own text: what was left of the
    // previous one is said first, so the answer after a tool is not glued to it or lost.
    session.on('assistant-start', () => {
      if (!entry.chunker) return;
      const rest = entry.chunker.finish();
      if (rest) this._say(callId, entry, [rest]);
      entry.chunker = this.createChunker();
    });
    session.on('text', ({ delta }) => {
      if (!entry.chunker) return;
      this._say(callId, entry, entry.chunker.push(delta));
    });
    session.on('assistant-message', ({ text, aborted }) => {
      if (!text || aborted) return;
      // Kept in the call, not read again: it was spoken while streamed, or it is caught up on later.
      const msg = this.broker.addCallMessage(callId, { role: 'assistant', text, speech: '', silent: true, kind: 'stream' });
      if (msg) entry.turnMsgs.push(msg);
      if (entry.msgMissed || !this._onLine(callId)) entry.missed.push(toSpeech(text));
      entry.offline = [];
      entry.msgMissed = false;
    });
    session.on('turn-end', ({ aborted } = {}) => {
      const rest = !aborted && entry.chunker ? entry.chunker.finish() : '';
      if (rest) this._say(callId, entry, [rest]);
      if (entry.voiceTurn && this._onLine(callId)) this.voice.streamTurnEnd();
      entry.voiceTurn = false;
      entry.chunker = null;
      entry.turnOpen = false;
      // Nobody heard how it ended: the last message is what the user hears on picking up.
      const last = entry.turnMsgs.at(-1);
      if (!this._onLine(callId) && last && (entry.missed.length || entry.msgMissed || entry.offline.length)) {
        last.silent = false;
        last.speech = toSpeech(last.text);
        this.broker.messagesChanged(callId);
      }
      Object.assign(entry, { offline: [], msgMissed: false, missed: [], turnMsgs: [] });
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
        this.broker.cancel(callId);
        this._nextPrompt(callId, entry);
      } else {
        entry.prompts = entry.prompts.filter(q => q.requestId !== requestId);
      }
    });
    session.on('exit', () => {
      if (entry.ended) return;
      entry.ended = true;
      entry.prompts = [];
      this.broker.setStreamBusy(callId, false);
      this.broker.addCallMessage(callId, { role: 'system', text: 'La sesión de Claude se ha cerrado. Cuelga cuando quieras.', kind: 'note' });
      this.broker.ringStreamCall(callId); // hung up while it worked: the user should know
    });
    session.on('error', err => this.log(`Sesión controlada: ${err?.message || err}`));
  }

  // Claude's sentences: spoken when someone is on the line, kept for the catch-up otherwise.
  _say(callId, entry, sentences) {
    if (!sentences.length) return;
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
    if (!entry.voiceTurn) {
      this.voice.streamTurnStart();
      entry.voiceTurn = true;
    }
    const parts = [...entry.missed.slice(-1), ...entry.offline];
    entry.missed = [];
    entry.offline = [];
    entry.msgMissed = false;
    for (const part of parts) this.voice.streamSentence(part);
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
    this.broker.setStreamBusy(callId, false);
    this.broker.ringStreamCall(callId);
  }

  // Claude can ask several things at once (parallel tools): one is asked in the call at a time.
  _permission(callId, entry, p) {
    if (entry.prompt) { entry.prompts.push(p); return; }
    entry.prompt = p.requestId;
    const payload = { session_id: entry.session.sessionId, cwd: entry.cwd, tool_name: p.toolName, tool_input: p.input || {} };
    const responder = (body) => {
      const d = decisionFor(body, p.input);
      if (d.allow) entry.session.allow(p.requestId, d.input);
      else entry.session.deny(p.requestId, d.message);
      if (entry.prompt === p.requestId) {
        entry.prompt = null;
        this._nextPrompt(callId, entry);
      }
      return true;
    };
    // 'on': these prompts belong to this call (the session's own plugin hooks are off).
    const handled = p.toolName === 'AskUserQuestion'
      ? this.broker.receiveAskUser(payload, responder, 'on')
      : this.broker.receivePermission(payload, responder, 'on');
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
    this.broker.addCallMessage(callId, { role: 'system', text: 'No se ha podido enviar a Claude. Repítelo o escríbelo.', kind: 'note' });
    this._idleCheck(callId, entry);
  }

  // A controlled call that is no longer in the broker (hung up while idle) closes its Claude session.
  _reap() {
    for (const [callId, entry] of this.calls) {
      if (this.broker.calls.has(callId)) continue;
      this.calls.delete(callId);
      entry.ended = true;
      this.broker.releaseSession(entry.session.sessionId);
      Promise.resolve(entry.session.close()).catch(err => this.log(`Cerrar sesión: ${err?.message || err}`));
    }
  }

  // AgentCall is quitting. A Claude left running unattended would go on using tools, so what does not
  // close in time is killed.
  async closeAll({ timeoutMs = 5000 } = {}) {
    const all = [...this.calls.values()];
    this.calls.clear();
    for (const e of all) { e.ended = true; this.broker.releaseSession(e.session.sessionId); }
    const closed = Promise.all(all.map(e => Promise.resolve(e.session.close()).catch(() => {})));
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
