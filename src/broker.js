'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');

const SNOOZE_MINUTES = [1,2,3,4,5,6,7,8,9,10,15,20,30,45,60,120];
const RING_TIMEOUT_MS = 30_000;

function cleanText(value, max = 4000) {
  if (value == null) return '';
  const text = String(value).replace(/\r/g, '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function compact(value, max = 120) {
  const text = cleanText(value, max * 4).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function displayName(payload = {}) {
  if (payload.session_title) return payload.session_title;
  if (payload.cwd) return path.basename(payload.cwd) || payload.cwd;
  return 'Claude';
}

function miniContext(payload = {}, fallback = '') {
  if (payload._agentcall_topic) return compact(payload._agentcall_topic, 150);
  if (payload.prompt) return compact(payload.prompt, 150);
  return compact(fallback, 150) || 'Claude necesita tu atención.';
}

function questionText(q) {
  if (!q) return '';
  const options = Array.isArray(q.options) && q.options.length
    ? `\n${q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')}`
    : '';
  return `${q.question || 'Claude necesita una respuesta.'}${options}`;
}

class CallBroker extends EventEmitter {
  constructor({ ringTimeoutMs = RING_TIMEOUT_MS, now = () => Date.now() } = {}) {
    super();
    this.ringTimeoutMs = ringTimeoutMs;
    this.now = now;
    this.calls = new Map();
    this.ringTimers = new Map();
    this.snoozeTimers = new Map();
    this.activeId = null;
    this.dnd = false;
    this.topics = new Map();
  }

  setDnd(value) {
    this.dnd = Boolean(value);
    if (this.dnd) {
      for (const call of this.calls.values()) {
        if (call.status === 'ringing') this._moveToPending(call);
      }
    } else {
      this._ringNextIfPossible();
    }
    this._changed();
  }

  updateTopic(payload = {}) {
    if (!payload.session_id) return;
    this.topics.set(payload.session_id, {
      prompt: cleanText(payload.prompt, 1000),
      sessionTitle: cleanText(payload.session_title, 200),
      cwd: cleanText(payload.cwd, 600),
      updatedAt: this.now(),
    });
    this._changed();
  }

  receiveAskUser(payload, responder) {
    const questions = Array.isArray(payload?.tool_input?.questions) ? payload.tool_input.questions : [];
    const first = questions[0];
    return this._receiveInteractive({
      payload,
      responder,
      interactionKind: 'ask',
      title: displayName(payload),
      context: this._contextFor(payload, first?.header || first?.question || 'Pregunta de Claude'),
      questions,
      initialText: questionText(first),
    });
  }

  receivePermission(payload, responder) {
    const toolName = payload.tool_name || 'herramienta';
    const description = payload?.tool_input?.description || payload?.tool_input?.command || '';
    const text = description
      ? `Claude pide permiso para usar ${toolName}.\n${cleanText(description, 1200)}\n\n¿Lo permites? Di “sí” o “no”.`
      : `Claude pide permiso para usar ${toolName}. ¿Lo permites? Di “sí” o “no”.`;
    return this._receiveInteractive({
      payload,
      responder,
      interactionKind: 'permission',
      title: displayName(payload),
      context: this._contextFor(payload, `Permiso: ${toolName}`),
      questions: [],
      initialText: text,
    });
  }

  receiveCompletion(payload = {}, { failure = false, responder = null } = {}) {
    const sessionId = payload.session_id || `unknown-${crypto.randomUUID()}`;
    const content = cleanText(
      failure ? (payload.last_assistant_message || payload.error_details || payload.error || 'Claude terminó con un error.')
              : (payload.last_assistant_message || 'Claude ha terminado.'),
      20_000,
    );

    const active = this._active();
    if (active && active.sessionId === sessionId) {
      active.messages.push({ role: 'assistant', text: content, at: this.now(), kind: failure ? 'error' : 'completion' });
      active.awaitingClaude = false;
      active.type = failure ? 'error' : 'completion';
      active.interactionKind = failure ? null : 'stop';
      active.responder = failure ? null : responder;
      active.resolved = failure;
      active.context = this._contextFor(payload, content);
      active.payload = payload;
      active.updatedAt = this.now();
      this._changed('message', { id: active.id, message: active.messages.at(-1) });
      return active;
    }

    const call = this._newCall({
      sessionId,
      type: failure ? 'error' : 'completion',
      interactionKind: failure ? null : 'stop',
      title: displayName(payload),
      context: this._contextFor(payload, content),
      payload,
      responder: failure ? null : responder,
      messages: [{ role: 'assistant', text: content, at: this.now(), kind: failure ? 'error' : 'completion' }],
      resolved: failure,
    });
    this._enqueueOrRing(call);
    return call;
  }

  answer(id) {
    const call = this.calls.get(id);
    if (!call) return false;
    if (this.activeId && this.activeId !== id) return false;
    this._clearRingTimer(id);
    this._clearSnoozeTimer(id);
    call.status = 'active';
    call.updatedAt = this.now();
    this.activeId = id;
    this._changed('active', { id });
    return true;
  }

  snooze(id, minutes) {
    const call = this.calls.get(id);
    const min = Number(minutes);
    if (!call || !SNOOZE_MINUTES.includes(min)) return false;
    if (this.activeId === id) return false;
    this._clearRingTimer(id);
    this._clearSnoozeTimer(id);
    call.status = 'snoozed';
    call.snoozedUntil = this.now() + min * 60_000;
    call.updatedAt = this.now();
    const timer = setTimeout(() => {
      this.snoozeTimers.delete(id);
      const current = this.calls.get(id);
      if (!current || current.status !== 'snoozed') return;
      current.snoozedUntil = null;
      if (this.dnd) this._moveToPending(current);
      else if (this.activeId) this._moveToQueued(current);
      else this._startRinging(current);
    }, min * 60_000);
    timer.unref?.();
    this.snoozeTimers.set(id, timer);
    this._changed();
    return true;
  }

  hangup(id = this.activeId) {
    const call = this.calls.get(id);
    if (!call) return false;
    if (this.activeId === id) this.activeId = null;

    if (call.responder && !call.resolved && call.interactionKind === 'stop') {
      const fn = call.responder;
      call.responder = null;
      call.resolved = true;
      if (typeof fn === 'function') fn({});
      this._deleteCall(id);
    } else if (call.responder && !call.resolved) {
      call.status = 'pending';
      call.updatedAt = this.now();
    } else {
      this._deleteCall(id);
    }
    this._ringNextIfPossible();
    this._changed('hangup', { id });
    return true;
  }

  submitUserText(id, rawText) {
    const call = this.calls.get(id);
    const text = cleanText(rawText, 4000);
    if (!call || call.status !== 'active' || !text) return { ok: false, error: 'No hay una llamada activa o el texto está vacío.' };

    call.messages.push({ role: 'user', text, at: this.now(), kind: 'answer' });
    call.updatedAt = this.now();

    if (!call.responder || call.resolved) {
      this._changed('message', { id, message: call.messages.at(-1) });
      return { ok: true, informational: true };
    }

    if (call.interactionKind === 'stop') {
      const response = {
        hookSpecificOutput: {
          hookEventName: 'Stop',
          additionalContext: `Respuesta del usuario mediante AgentCall: ${text}`,
        },
      };
      this._resolveResponder(call, response);
      return { ok: true, resolved: true, continued: true };
    }

    if (call.interactionKind === 'permission') {
      const decision = parsePermission(text);
      if (!decision) {
        const response = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'deny',
              message: `El usuario no ha autorizado todavía la acción y ha respondido mediante AgentCall: ${text}. Responde a su comentario o aclaración y vuelve a pedir permiso si la acción sigue siendo necesaria.`,
              interrupt: false,
            },
          },
        };
        this._resolveResponder(call, response);
        return { ok: true, resolved: true, clarification: true };
      }
      const response = decision === 'allow'
        ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
        : { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'El usuario denegó el permiso desde AgentCall.', interrupt: false } } };
      this._resolveResponder(call, response);
      return { ok: true, resolved: true, decision };
    }

    if (call.interactionKind === 'ask') {
      const questions = call.questions || [];
      const current = questions[call.questionIndex] || questions[0];
      const matched = matchQuestionAnswer(current, text);

      if (!matched) {
        const response = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Respuesta natural del usuario mediante AgentCall: ${text}. Trátala como respuesta del usuario. Si resuelve la decisión, actúa en consecuencia. Si pide una aclaración, contéstala y vuelve a preguntar solo si aún necesitas una decisión.`,
          },
        };
        this._resolveResponder(call, response);
        return { ok: true, resolved: true, clarification: true };
      }

      if (current?.question) call.answers[current.question] = matched;
      call.questionIndex += 1;
      if (call.questionIndex < questions.length) {
        const next = questions[call.questionIndex];
        const message = { role: 'assistant', text: questionText(next), at: this.now(), kind: 'question' };
        call.messages.push(message);
        this._changed('message', { id, message });
        return { ok: true, resolved: false, nextQuestion: true };
      }

      const originalQuestions = call.payload?.tool_input?.questions || questions;
      const response = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Respuesta recogida por AgentCall.',
          updatedInput: {
            ...call.payload.tool_input,
            questions: originalQuestions,
            answers: call.answers,
          },
        },
      };
      this._resolveResponder(call, response);
      return { ok: true, resolved: true };
    }

    this._changed();
    return { ok: true };
  }

  getSnapshot() {
    const calls = [...this.calls.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((call) => this._publicCall(call));
    return {
      dnd: this.dnd,
      activeId: this.activeId,
      snoozeOptions: [...SNOOZE_MINUTES],
      calls,
      counts: {
        ringing: calls.filter(c => c.status === 'ringing').length,
        queued: calls.filter(c => c.status === 'queued').length,
        pending: calls.filter(c => c.status === 'pending').length,
        snoozed: calls.filter(c => c.status === 'snoozed').length,
      },
    };
  }

  exportPersistentState() {
    return {
      dnd: this.dnd,
      calls: [...this.calls.values()]
        .filter(c => ['pending', 'snoozed', 'queued'].includes(c.status))
        .map(c => ({
          id: c.id,
          sessionId: c.sessionId,
          type: c.type,
          title: c.title,
          context: c.context,
          status: c.responder && !c.resolved ? 'stale' : c.status,
          snoozedUntil: c.snoozedUntil || null,
          createdAt: c.createdAt,
          note: c.responder && !c.resolved ? 'La petición síncrona pertenecía a una ejecución anterior y debe retomarse desde Claude.' : undefined,
        })),
    };
  }

  _receiveInteractive({ payload, responder, interactionKind, title, context, questions, initialText }) {
    const sessionId = payload.session_id || `unknown-${crypto.randomUUID()}`;
    const active = this._active();
    if (active && active.sessionId === sessionId) {
      active.type = 'interaction';
      active.interactionKind = interactionKind;
      active.payload = payload;
      active.responder = responder;
      active.resolved = false;
      active.awaitingClaude = false;
      active.questions = questions || [];
      active.questionIndex = 0;
      active.answers = {};
      active.context = context;
      const message = { role: 'assistant', text: initialText, at: this.now(), kind: interactionKind };
      active.messages.push(message);
      active.updatedAt = this.now();
      this._changed('message', { id: active.id, message });
      return active;
    }

    const call = this._newCall({
      sessionId,
      type: 'interaction',
      interactionKind,
      title,
      context,
      payload,
      responder,
      questions: questions || [],
      questionIndex: 0,
      answers: {},
      messages: [{ role: 'assistant', text: initialText, at: this.now(), kind: interactionKind }],
      resolved: false,
    });
    this._enqueueOrRing(call);
    return call;
  }

  _resolveResponder(call, response) {
    const fn = call.responder;
    call.resolved = true;
    call.awaitingClaude = true;
    call.responder = null;
    call.updatedAt = this.now();
    if (typeof fn === 'function') fn(response);
    this._changed('awaiting', { id: call.id });
  }

  _newCall(data) {
    const now = this.now();
    const call = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: 'new',
      snoozedUntil: null,
      awaitingClaude: false,
      ...data,
    };
    this.calls.set(call.id, call);
    return call;
  }

  _enqueueOrRing(call) {
    if (this.dnd) this._moveToPending(call);
    else if (this.activeId) this._moveToQueued(call);
    else this._startRinging(call);
  }

  _startRinging(call) {
    call.status = 'ringing';
    call.updatedAt = this.now();
    this._clearRingTimer(call.id);
    const timer = setTimeout(() => {
      this.ringTimers.delete(call.id);
      const current = this.calls.get(call.id);
      if (current?.status === 'ringing') this._moveToPending(current);
    }, this.ringTimeoutMs);
    timer.unref?.();
    this.ringTimers.set(call.id, timer);
    this._changed('ringing', { id: call.id });
  }

  _moveToPending(call) {
    this._clearRingTimer(call.id);
    call.status = 'pending';
    call.updatedAt = this.now();
    this._changed('pending', { id: call.id });
  }

  _moveToQueued(call) {
    this._clearRingTimer(call.id);
    call.status = 'queued';
    call.updatedAt = this.now();
    this._changed('queued', { id: call.id });
  }

  _ringNextIfPossible() {
    if (this.dnd || this.activeId) return;
    const next = [...this.calls.values()]
      .filter(c => c.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next) this._startRinging(next);
  }

  _contextFor(payload, fallback) {
    const topic = this.topics.get(payload.session_id);
    return compact(
      payload.session_title || topic?.sessionTitle || topic?.prompt || fallback,
      160,
    );
  }

  _active() {
    return this.activeId ? this.calls.get(this.activeId) : null;
  }

  _publicCall(call) {
    return {
      id: call.id,
      sessionId: call.sessionId,
      type: call.type,
      interactionKind: call.interactionKind,
      title: call.title,
      context: call.context,
      status: call.status,
      snoozedUntil: call.snoozedUntil,
      awaitingClaude: call.awaitingClaude,
      resolved: call.resolved,
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
      questionIndex: call.questionIndex || 0,
      questionCount: call.questions?.length || 0,
      messages: call.messages || [],
    };
  }

  _clearRingTimer(id) {
    const timer = this.ringTimers.get(id);
    if (timer) clearTimeout(timer);
    this.ringTimers.delete(id);
  }

  _clearSnoozeTimer(id) {
    const timer = this.snoozeTimers.get(id);
    if (timer) clearTimeout(timer);
    this.snoozeTimers.delete(id);
  }

  _deleteCall(id) {
    this._clearRingTimer(id);
    this._clearSnoozeTimer(id);
    this.calls.delete(id);
  }

  _changed(event = 'state', detail = {}) {
    this.emit('change', this.getSnapshot(), { event, ...detail });
  }
}

function normalizeChoice(text) {
  return String(text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function matchQuestionAnswer(question, text) {
  const options = Array.isArray(question?.options) ? question.options : [];
  if (!options.length) return null;
  const value = normalizeChoice(text);
  const matches = [];
  const clarification = /^(por que|porque|como|para que|que pasa|que ocurre|y si|puedes|podrias|explica|explicame|dime|antes de|espera)\b/.test(value);
  if (clarification) return null;

  options.forEach((option, index) => {
    const label = String(option.label || '').trim();
    const nLabel = normalizeChoice(label);
    const ordinalWords = [
      ['1', 'uno', 'una', 'primera', 'primero'],
      ['2', 'dos', 'segunda', 'segundo'],
      ['3', 'tres', 'tercera', 'tercero'],
      ['4', 'cuatro', 'cuarta', 'cuarto'],
    ][index] || [];
    const exactLetter = label.length === 1 && /^[A-Za-z]$/.test(label) && new RegExp(`(^| )${label.toLowerCase()}($| )`).test(value);
    const labelMatch = nLabel && (label.length > 1 ? (value === nLabel || value.includes(nLabel)) : value === nLabel);
    const ordinalMatch = ordinalWords.some(word => new RegExp(`(^| )${word}($| )`).test(value));
    if (exactLetter || labelMatch || ordinalMatch) matches.push(label);
  });

  if (!matches.length) return null;
  if (question?.multiSelect) return [...new Set(matches)].join(', ');
  return matches[0];
}

function parsePermission(text) {
  const value = String(text).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const yes = /^(si|sí|vale|ok|okay|permitir|permite|adelante|hazlo|de acuerdo|autorizo|acepto)\b/.test(value);
  const no = /^(no|denegar|deniega|rechazar|rechaza|no lo hagas|no hagas|para)\b/.test(value);
  if (yes && !no) return 'allow';
  if (no && !yes) return 'deny';
  return null;
}

module.exports = { CallBroker, SNOOZE_MINUTES, RING_TIMEOUT_MS, parsePermission, matchQuestionAnswer, compact };
