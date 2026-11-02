'use strict';
// StreamCallController: a "controlled" call (Voice First §6). The user calls Claude from AgentCall;
// AgentCall drives that Claude Code session itself through stream-json (src/voice/stream-session.js),
// so Claude's answer is spoken while it is written, the user can add or correct things mid-turn and
// an interruption really stops Claude. Permission prompts and AskUserQuestion go through the broker
// like hook prompts do, so they are answered by voice, buttons or text exactly as in hook mode.
const { EventEmitter } = require('node:events');

const GREETING = 'Dime.';

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
  constructor({ broker, voice, createSession, createChunker, log = () => {} }) {
    super();
    this.broker = broker;
    this.voice = voice;
    this.createSession = createSession;
    this.createChunker = createChunker;
    this.log = log;
    this.calls = new Map(); // callId → { session, cwd, chunker, ended, messages: Map(uuid → msg) }
    broker.on('change', () => this._reap());
  }

  owns(callId) { return this.calls.has(callId); }

  async start({ cwd, resume = null }) {
    const session = this.createSession({ cwd, resume });
    await session.start();
    const call = this.broker.openStreamCall({ sessionId: session.sessionId, cwd });
    const entry = { session, cwd, chunker: null, ended: false, messages: new Map() };
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
    const msg = this.broker.addCallMessage(callId, { role: 'user', text, kind: busy ? 'queued' : 'answer', urgency, delivered: !busy });
    const sent = busy && urgency === 'interrupt' ? session.sendUrgent(text) : session.send(text);
    const track = uuid => { if (uuid && busy) entry.messages.set(uuid, msg); };
    if (sent && typeof sent.then === 'function') sent.then(track, err => this._failed(callId, err));
    else track(sent);
    return { ok: true, route: busy ? 'steer' : 'answer', stream: true, queued: busy };
  }

  _bind(callId, entry) {
    const { session } = entry;
    session.on('turn-start', () => {
      this.broker.setStreamBusy(callId, true);
      entry.chunker = this.createChunker();
      this.voice.streamTurnStart();
    });
    session.on('text', ({ delta }) => {
      if (!entry.chunker) return;
      for (const sentence of entry.chunker.push(delta)) this.voice.streamSentence(sentence);
    });
    session.on('assistant-message', ({ text, aborted }) => {
      // Already spoken while streamed: kept in the call, not read again.
      if (text && !aborted) this.broker.addCallMessage(callId, { role: 'assistant', text, speech: '', silent: true, kind: 'stream' });
    });
    session.on('turn-end', ({ aborted } = {}) => {
      const rest = !aborted && entry.chunker ? entry.chunker.finish() : '';
      if (rest) this.voice.streamSentence(rest);
      this.voice.streamTurnEnd();
      entry.chunker = null;
      this.broker.setStreamBusy(callId, Boolean(session.busy));
    });
    session.on('message', ({ uuid, state }) => {
      const msg = entry.messages.get(uuid);
      if (!msg || (state !== 'started' && state !== 'completed')) return;
      msg.delivered = true;
      entry.messages.delete(uuid);
      this.broker.messagesChanged(callId);
    });
    session.on('permission', (p) => this._permission(callId, entry, p));
    session.on('exit', () => {
      if (entry.ended) return;
      entry.ended = true;
      this.broker.setStreamBusy(callId, false);
      this.broker.addCallMessage(callId, { role: 'system', text: 'La sesión de Claude se ha cerrado. Cuelga cuando quieras.', kind: 'note' });
    });
    session.on('error', err => this.log(`Sesión controlada: ${err?.message || err}`));
  }

  _permission(callId, entry, p) {
    const payload = { session_id: entry.session.sessionId, cwd: entry.cwd, tool_name: p.toolName, tool_input: p.input || {} };
    const responder = (body) => {
      const d = decisionFor(body, p.input);
      if (d.allow) entry.session.allow(p.requestId, d.input);
      else entry.session.deny(p.requestId, d.message);
      return true;
    };
    // 'on': these prompts belong to the call the user is in (the session's own plugin hooks are off).
    const handled = p.toolName === 'AskUserQuestion'
      ? this.broker.receiveAskUser(payload, responder, 'on')
      : this.broker.receivePermission(payload, responder, 'on');
    if (!handled) this.log(`Permiso ${p.toolName} resuelto sin llamada`);
  }

  _failed(callId, err) {
    this.log(`No se pudo enviar a Claude: ${err?.message || err}`);
    this.broker.addCallMessage(callId, { role: 'system', text: 'No se ha podido enviar a Claude. Repítelo o escríbelo.', kind: 'note' });
  }

  // A controlled call that is no longer in the broker (hung up) closes its Claude session.
  _reap() {
    for (const [callId, entry] of this.calls) {
      if (this.broker.calls.has(callId)) continue;
      this.calls.delete(callId);
      entry.ended = true;
      Promise.resolve(entry.session.close()).catch(err => this.log(`Cerrar sesión: ${err?.message || err}`));
    }
  }

  async closeAll() {
    const all = [...this.calls.values()];
    this.calls.clear();
    await Promise.all(all.map(e => Promise.resolve(e.session.close()).catch(() => {})));
  }
}

module.exports = { StreamCallController, decisionFor, GREETING };
