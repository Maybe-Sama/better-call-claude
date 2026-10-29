'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');
const { toSpeech } = require('./speech-text');

const SNOOZE_MINUTES = [1,2,3,4,5,6,7,8,9,10,15,20,30,45,60,120];
const RING_TIMEOUT_MS = 30_000;
// A turn shorter than this, with no question/permission in between, is treated as routine chat the
// user is watching in the terminal: the Stop hook is released immediately and no result call rings.
const MIN_RESULT_TURN_MS = 20_000;
const TITLE_CACHE_MS = 30_000;

// Hook replies. `{}` always means "AgentCall has no opinion": Claude Code continues as if the hook
// did not exist (native terminal dialog for permissions/questions, normal stop for Stop).
const NO_DECISION = Object.freeze({});

// "/better-call-saul on|off" (user command) or "/agentcall:better-call-saul on|off" (plugin command).
const TOGGLE_COMMAND = /^\s*\/(?:agentcall:)?better-call-saul\b\s*(on|off|status|estado)?/i;

// Interaction rules Claude receives when calls are enabled for a session (SessionStart or "/better-call-saul on").
const CALL_RULES = `AgentCall is active for this session: the user supervises Claude Code from a Windows voice-call app.
Questions, permission prompts and the final message of a turn are spoken aloud to the user in a phone-style call, in Spanish, and the user answers by voice, text or quick-answer buttons.

Interaction rules:
- Work autonomously through ordinary implementation details. Do not ask about trivial choices you can safely make yourself.
- When you genuinely need a decision, missing information or a clarification, use AskUserQuestion. Keep 2-4 options with short, distinct labels that are easy to say aloud.
- An AskUserQuestion answer may be free text instead of an option. If it is itself a question or doubt, answer it first; ask again only if a decision is still needed. Never assume a choice the user did not make.
- When a turn ends with something the user should hear (a finished piece of work, a blocker, a result), start the final message with one short spoken-style paragraph (1-3 sentences, no markdown, no code, no file paths, no URLs) saying what happened, the outcome and what matters next. Put technical detail after that paragraph. If you need something from the user, say it in the last paragraph.
- If the user replies during the result call, their reply arrives as additional context of this same session: treat it as a new user request.
- Do not mention AgentCall or add special tags or boilerplate. Write normally.`;

const CALLS_OFF_NOTE = 'AgentCall voice calls are now disabled for this session. Ignore the earlier call-related rules and interact normally through the terminal.';

function cleanText(value, max = 4000) {
  if (value == null) return '';
  const text = String(value).replace(/\r/g, '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function compact(value, max = 120) {
  const text = cleanText(value, max * 4).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function projectName(payload = {}) {
  if (payload.cwd) return path.win32.basename(String(payload.cwd).replace(/[\\/]+$/, '')) || payload.cwd;
  return 'Claude';
}

function questionText(q) {
  if (!q) return '';
  const options = Array.isArray(q.options) && q.options.length
    ? `\n${q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')}`
    : '';
  return `${q.question || 'Claude necesita una respuesta.'}${options}`;
}

function questionSpeech(q) {
  if (!q) return '';
  const options = Array.isArray(q.options) ? q.options : [];
  const list = options.map((o, i) => `${ORDINAL_SPEECH[i] || `opción ${i + 1}`}: ${labelCore(o.label)}${RECOMMENDED.test(o.label) ? ', la recomendada' : ''}`).join('. ');
  return `${q.question || 'Claude necesita una respuesta.'}${list ? ` ${list}.` : ''}`;
}
const ORDINAL_SPEECH = ['Primera', 'Segunda', 'Tercera', 'Cuarta', 'Quinta'];
// Claude marks its suggestion in the label: "Supabase Auth (Recomendado)".
const RECOMMENDED = /\((recomendad[oa]|recommended)\)/i;
function labelCore(label) { return String(label || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim(); }

function describePermission(payload = {}) {
  const tool = payload.tool_name || 'una herramienta';
  const input = payload.tool_input || {};
  if (tool === 'ExitPlanMode') {
    const plan = cleanText(input.plan, 12_000);
    return {
      text: `Claude ha preparado un plan y quiere empezar a ejecutarlo.${plan ? `\n\n${plan}` : ''}\n\n¿Lo apruebas? Di “sí” o “no”.`,
      speech: 'Claude ha preparado un plan y quiere empezar a ejecutarlo. ¿Lo apruebas?',
      short: 'Aprobar plan',
    };
  }
  let what = '';
  if (input.command) what = input.command;
  else if (input.file_path) what = input.file_path;
  else if (input.url) what = input.url;
  else if (input.path) what = input.path;
  else if (input.pattern) what = input.pattern;
  const description = input.description && input.description !== what ? input.description : '';
  const lines = [`Claude pide permiso para usar ${tool}.`];
  if (description) lines.push(cleanText(description, 400));
  if (what) lines.push(cleanText(what, 1200));
  lines.push('', '¿Lo permites? Di “sí” o “no”.');
  const spokenWhat = description || (what && what.length <= 120 ? what : '');
  return {
    text: lines.join('\n'),
    speech: `Claude pide permiso para usar ${tool}.${spokenWhat ? ` ${spokenWhat}.` : ''} ¿Lo permites?`,
    short: `Permiso: ${tool}`,
  };
}

class CallBroker extends EventEmitter {
  constructor({
    ringTimeoutMs = RING_TIMEOUT_MS,
    minResultMs = MIN_RESULT_TURN_MS,
    now = () => Date.now(),
    readTitle = () => '',
    defaultMode = 'off',
  } = {}) {
    super();
    this.ringTimeoutMs = ringTimeoutMs;
    this.minResultMs = minResultMs;
    this.now = now;
    this.readTitle = readTitle;
    this.calls = new Map();
    this.ringTimers = new Map();
    this.snoozeTimers = new Map();
    this.sessions = new Map();
    this.activeId = null;
    this.dnd = false;
    // Per-session on/off ("/better-call-saul"). Sessions without an explicit choice use the hint sent by the
    // launcher (X-AgentCall-Mode header) or defaultMode.
    this.defaultMode = defaultMode === 'on' ? 'on' : 'off';
    this.sessionModes = new Map();
  }

  setDnd(value) {
    this.dnd = Boolean(value);
    if (this.dnd) {
      for (const call of this.calls.values()) {
        if (call.status === 'ringing' || call.status === 'queued') this._moveToPending(call);
      }
    } else {
      this._ringNextIfPossible();
    }
    this._changed();
  }

  // ── Hook events ────────────────────────────────────────────────────────────

  // UserPromptSubmit: the user is typing in the terminal. Any request still held for this session is
  // stale (the user chose the terminal), so release it and let Claude Code continue normally.
  // Is AgentCall enabled for this session? hint: value of the X-AgentCall-Mode header ("on"/"off"/"").
  sessionMode(sessionId, hint = '') {
    if (sessionId && this.sessionModes.has(sessionId)) return this.sessionModes.get(sessionId);
    if (hint === 'on' || hint === 'off') return hint;
    return this.defaultMode;
  }

  setSessionMode(sessionId, mode) {
    if (!sessionId) return;
    this.sessionModes.set(sessionId, mode === 'on' ? 'on' : 'off');
    if (this.sessionModes.size > 300) this.sessionModes.delete(this.sessionModes.keys().next().value);
    if (mode !== 'on') this._releaseSession(sessionId, null, 'Llamadas desactivadas para esta sesión.');
    this._changed('mode', { sessionId, mode });
  }

  // SessionStart: the call rules go into the session only when calls are on for it.
  sessionStartContext(payload = {}, hint = '') {
    return this.sessionMode(payload.session_id, hint) === 'on' ? CALL_RULES : null;
  }

  // UserPromptSubmit. Returns additionalContext for Claude when the prompt is "/better-call-saul on|off".
  notePrompt(payload = {}, hint = '') {
    if (!payload.session_id) return null;
    const toggle = TOGGLE_COMMAND.exec(String(payload.prompt || ''));
    if (toggle) {
      const wanted = (toggle[1] || 'status').toLowerCase();
      this._session(payload).quietStop = true; // Claude's one-line confirmation is not a result worth a call
      if (wanted === 'on' || wanted === 'off') this.setSessionMode(payload.session_id, wanted);
      const mode = this.sessionMode(payload.session_id, hint);
      if (wanted === 'on') return `AgentCall: llamadas ACTIVADAS para esta sesión.\n\n${CALL_RULES}`;
      if (wanted === 'off') return `AgentCall: llamadas DESACTIVADAS para esta sesión. ${CALLS_OFF_NOTE}`;
      return `AgentCall: las llamadas están ${mode === 'on' ? 'ACTIVADAS' : 'DESACTIVADAS'} en esta sesión.`;
    }
    const session = this._session(payload);
    const prompt = cleanText(payload.prompt, 1000);
    if (prompt) {
      if (!session.firstPrompt) session.firstPrompt = prompt;
      session.lastPrompt = prompt;
    }
    session.lastPromptAt = this.now();
    session.interacted = false;
    this._releaseSession(payload.session_id, null, 'Has seguido en la terminal; esta petición ya no está pendiente.');
    this._changed();
    return null;
  }

  // PostToolUse: if the user answered a permission prompt in the terminal, the matching held
  // PermissionRequest is obsolete. Claude Code never closes that HTTP request, so we detect it here.
  noteToolDone(payload = {}) {
    if (!payload.session_id) return;
    const signature = toolSignature(payload);
    for (const call of [...this.calls.values()]) {
      if (call.sessionId !== payload.session_id || call.interactionKind !== 'permission' || call.resolved) continue;
      if (call.toolSignature === signature) this._release(call, 'Permiso resuelto en la terminal.');
    }
  }

  // Calls disabled for this session: Claude Code continues exactly as without AgentCall.
  _off(payload, responder, hint) {
    if (this.sessionMode(payload.session_id, hint) === 'on') return false;
    responder?.(NO_DECISION);
    return true;
  }

  receiveAskUser(payload = {}, responder, hint = '') {
    if (this._off(payload, responder, hint)) return null;
    const questions = Array.isArray(payload?.tool_input?.questions) ? payload.tool_input.questions : [];
    if (!questions.length) {
      responder?.(NO_DECISION);
      return null;
    }
    const first = questions[0];
    return this._receiveInteractive({
      payload,
      responder,
      interactionKind: 'ask',
      detail: first.header || 'Pregunta',
      questions,
      message: { text: questionText(first), speech: questionSpeech(first) },
    });
  }

  receivePermission(payload = {}, responder, hint = '') {
    if (this._off(payload, responder, hint)) return null;
    if (payload.tool_name === 'AskUserQuestion') {
      // Questions are handled by the PreToolUse hook; never ring twice for the same thing.
      responder?.(NO_DECISION);
      return null;
    }
    const described = describePermission(payload);
    return this._receiveInteractive({
      payload,
      responder,
      interactionKind: 'permission',
      detail: described.short,
      questions: [],
      message: { text: described.text, speech: described.speech },
    });
  }

  receiveCompletion(payload = {}, { failure = false, responder = null, hint = '' } = {}) {
    if (this._off(payload, responder, hint)) return null;
    const sessionId = payload.session_id || `unknown-${crypto.randomUUID()}`;
    const session = this._session(payload);
    this._releaseSession(sessionId, null, null);

    const active = this._active();
    const sameActive = Boolean(active && active.sessionId === sessionId);
    if (session.quietStop && !failure) {
      session.quietStop = false;
      if (!sameActive) { responder?.(NO_DECISION); return null; }
    }
    const elapsed = session.lastPromptAt ? this.now() - session.lastPromptAt : Infinity;
    if (!failure && !sameActive && !payload.stop_hook_active && !session.interacted && elapsed < this.minResultMs) {
      responder?.(NO_DECISION);
      return null;
    }

    const content = failure
      ? cleanText(payload.last_assistant_message || payload.error_details || payload.error || payload.message || 'Claude se ha detenido por un error.', 20_000)
      : cleanText(payload.last_assistant_message || 'Claude ha terminado.', 20_000);
    const message = {
      role: 'assistant',
      text: content,
      speech: failure ? `Claude se ha detenido por un error. ${toSpeech(content, 300)}` : toSpeech(content),
      at: this.now(),
      kind: failure ? 'error' : 'completion',
    };

    if (sameActive) {
      active.messages.push(message);
      active.awaitingClaude = false;
      active.type = failure ? 'error' : 'completion';
      active.interactionKind = failure ? null : 'stop';
      active.responder = failure ? null : responder;
      active.resolved = failure;
      active.detail = failure ? 'Error' : 'Resultado';
      active.updatedAt = this.now();
      if (failure) responder?.(NO_DECISION);
      this._changed('message', { id: active.id, message });
      return active;
    }

    const call = this._newCall({
      sessionId,
      type: failure ? 'error' : 'completion',
      interactionKind: failure ? null : 'stop',
      title: projectName(payload),
      context: this._contextFor(payload, content),
      detail: failure ? 'Error' : 'Resultado',
      responder: failure ? null : responder,
      messages: [message],
      resolved: failure,
    });
    if (failure) responder?.(NO_DECISION);
    this._enqueueOrRing(call);
    return call;
  }

  // The HTTP request behind a held call went away (Claude interrupted, hook timed out…).
  cancel(id) {
    const call = this.calls.get(id);
    if (!call || call.resolved) return false;
    call.responder = null;
    this._release(call, 'Claude ya no espera esta respuesta (se resolvió o se interrumpió en la terminal).');
    return true;
  }

  // AgentCall is closing: answer every held hook with "no decision" so no session stays blocked.
  releaseAll() {
    for (const call of [...this.calls.values()]) {
      if (call.responder && !call.resolved) this._respond(call, NO_DECISION);
    }
  }

  // ── User actions ───────────────────────────────────────────────────────────

  answer(id) {
    const call = this.calls.get(id);
    if (!call) return false;
    if (this.activeId && this.activeId !== id) return false;
    this._clearRingTimer(id);
    this._clearSnoozeTimer(id);
    for (const other of this.calls.values()) {
      if (other.id !== id && other.status === 'ringing') this._moveToQueued(other);
    }
    call.status = 'active';
    call.snoozedUntil = null;
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
      this._enqueueOrRing(current);
    }, min * 60_000);
    timer.unref?.();
    this.snoozeTimers.set(id, timer);
    this._ringNextIfPossible();
    this._changed();
    return true;
  }

  hangup(id = this.activeId) {
    const call = this.calls.get(id);
    if (!call) return false;
    if (this.activeId === id) this.activeId = null;

    if (call.responder && !call.resolved && call.interactionKind === 'stop') {
      // Hanging up a result means "done": let Claude stop.
      this._respond(call, NO_DECISION);
      this._deleteCall(id);
    } else if (call.responder && !call.resolved) {
      // A question/permission is still unanswered: keep it in Pendientes so it can be called back.
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
      this._resolve(call, {
        hookSpecificOutput: {
          hookEventName: 'Stop',
          additionalContext: `El usuario ha escuchado tu resultado en una llamada de AgentCall y ha respondido (por voz o texto): «${text}». Atiende su respuesta en esta misma sesión.`,
        },
      });
      return { ok: true, resolved: true, continued: true };
    }

    if (call.interactionKind === 'permission') {
      const decision = parsePermission(text);
      let response;
      if (decision === 'allow') {
        response = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
      } else if (decision === 'deny') {
        response = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: `El usuario ha denegado el permiso desde AgentCall: «${text}».`, interrupt: false } } };
      } else {
        response = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'deny',
              message: `El usuario todavía no ha autorizado la acción. Ha respondido desde AgentCall: «${text}». Contesta a su comentario o pregunta y, si la acción sigue siendo necesaria, vuelve a intentarla para pedir permiso de nuevo.`,
              interrupt: false,
            },
          },
        };
      }
      this._resolve(call, response);
      return { ok: true, resolved: true, decision: decision || 'clarification', clarification: !decision };
    }

    if (call.interactionKind === 'ask') {
      const questions = call.questions || [];
      const current = questions[call.questionIndex] || questions[0];
      const clarification = isClarification(text);
      const matched = clarification ? null : matchQuestionAnswer(current, text);
      // Like the terminal's "Other" field: an unmatched answer is passed verbatim, never forced into an option.
      return this._answerQuestion(call, matched || text, { matched, clarification });
    }

    this._changed();
    return { ok: true };
  }

  // Quick-answer buttons: the user clicked option label(s) of the current question, or Sí/No on a permission.
  submitChoice(id, choice) {
    const call = this.calls.get(id);
    if (!call || call.status !== 'active' || !call.responder || call.resolved) return { ok: false, error: 'Claude ya no espera esta respuesta.' };
    if (call.interactionKind === 'permission') {
      return this.submitUserText(id, choice === 'allow' ? 'Sí' : 'No');
    }
    if (call.interactionKind !== 'ask') return { ok: false, error: 'Esta llamada no tiene opciones.' };
    const current = (call.questions || [])[call.questionIndex];
    const labels = (Array.isArray(choice) ? choice : [choice]).filter(l => current?.options?.some(o => o.label === l));
    if (!current || !labels.length) return { ok: false, error: 'Opción no válida.' };
    const answer = current.multiSelect ? labels.join(', ') : labels[0];
    call.messages.push({ role: 'user', text: answer, at: this.now(), kind: 'answer' });
    call.updatedAt = this.now();
    return this._answerQuestion(call, answer, { matched: answer, clarification: false });
  }

  _answerQuestion(call, answer, { matched, clarification }) {
    const id = call.id;
    const questions = call.questions || [];
    const current = questions[call.questionIndex] || questions[0];
    if (current?.question) call.answers[current.question] = answer;
    call.questionIndex += 1;

    if (!clarification && call.questionIndex < questions.length) {
      const next = questions[call.questionIndex];
      const message = { role: 'assistant', text: questionText(next), speech: questionSpeech(next), at: this.now(), kind: 'question' };
      call.messages.push(message);
      call.detail = next.header || call.detail;
      this._changed('message', { id, message });
      return { ok: true, resolved: false, nextQuestion: true, matched };
    }

    for (const q of questions) {
      if (q?.question && !(q.question in call.answers)) {
        call.answers[q.question] = '(sin responder: el usuario ha hecho antes una pregunta o aclaración)';
      }
    }
    this._resolve(call, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Respuesta recogida por AgentCall.',
        updatedInput: { ...call.toolInput, answers: { ...call.answers } },
      },
    });
    return { ok: true, resolved: true, matched, clarification };
  }

  // ── State ──────────────────────────────────────────────────────────────────

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

  // Only operational state survives a restart (DND). Held calls belong to live HTTP requests and
  // cannot be resumed after a restart, so they are never persisted; neither are transcripts.
  exportPersistentState() {
    return { dnd: this.dnd, sessionModes: Object.fromEntries(this.sessionModes) };
  }

  importPersistentState(saved = {}) {
    this.dnd = Boolean(saved.dnd);
    for (const [id, mode] of Object.entries(saved.sessionModes || {})) this.sessionModes.set(id, mode === 'on' ? 'on' : 'off');
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _receiveInteractive({ payload, responder, interactionKind, detail, questions, message }) {
    const sessionId = payload.session_id || `unknown-${crypto.randomUUID()}`;
    const session = this._session(payload);
    session.interacted = true;
    // Anything still held for this session is obsolete: Claude has moved on to a new request.
    this._releaseSession(sessionId, null, null);

    const fields = {
      type: 'interaction',
      interactionKind,
      responder,
      resolved: false,
      awaitingClaude: false,
      questions: questions || [],
      questionIndex: 0,
      answers: {},
      toolInput: payload.tool_input || {},
      toolSignature: toolSignature(payload),
      detail,
    };
    const fullMessage = { role: 'assistant', at: this.now(), kind: interactionKind, ...message };

    const active = this._active();
    if (active && active.sessionId === sessionId) {
      Object.assign(active, fields, { updatedAt: this.now() });
      active.messages.push(fullMessage);
      this._changed('message', { id: active.id, message: fullMessage });
      return active;
    }

    const call = this._newCall({
      sessionId,
      title: projectName(payload),
      context: this._contextFor(payload, detail),
      messages: [fullMessage],
      ...fields,
    });
    this._enqueueOrRing(call);
    return call;
  }

  _session(payload) {
    const id = payload.session_id || 'unknown';
    let session = this.sessions.get(id);
    if (!session) {
      session = { firstPrompt: '', lastPrompt: '', lastPromptAt: 0, interacted: false, title: '', titleAt: 0 };
      this.sessions.set(id, session);
    }
    if (payload.cwd) session.cwd = payload.cwd;
    if (payload.transcript_path) session.transcriptPath = payload.transcript_path;
    return session;
  }

  _contextFor(payload, fallback) {
    const session = this._session(payload);
    if (session.transcriptPath && this.now() - session.titleAt > TITLE_CACHE_MS) {
      session.title = this.readTitle(session.transcriptPath) || session.title;
      session.titleAt = this.now();
    }
    const meaningfulPrompt = session.lastPrompt && session.lastPrompt.length >= 25 ? session.lastPrompt : session.firstPrompt;
    return compact(session.title || meaningfulPrompt || session.lastPrompt || fallback || 'Claude necesita tu atención.', 140);
  }

  // Release every unresolved held request of a session (except `exceptId`) with "no decision".
  _releaseSession(sessionId, exceptId, note) {
    for (const call of [...this.calls.values()]) {
      if (call.sessionId !== sessionId || call.id === exceptId) continue;
      if (call.responder && !call.resolved) this._release(call, note);
    }
  }

  _release(call, note) {
    if (call.responder && !call.resolved) this._respond(call, NO_DECISION);
    call.resolved = true;
    if (this.activeId === call.id) {
      call.interactionKind = null;
      call.awaitingClaude = false;
      if (note) call.messages.push({ role: 'system', text: note, at: this.now(), kind: 'note' });
      call.updatedAt = this.now();
      this._changed('message', { id: call.id });
    } else {
      const wasRinging = call.status === 'ringing';
      this._deleteCall(call.id);
      if (wasRinging) this._ringNextIfPossible();
      this._changed();
    }
  }

  _respond(call, response) {
    const fn = call.responder;
    call.responder = null;
    call.resolved = true;
    if (typeof fn === 'function') fn(response);
  }

  _resolve(call, response) {
    this._respond(call, response);
    call.awaitingClaude = true;
    call.updatedAt = this.now();
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
      detail: '',
      ...data,
    };
    this.calls.set(call.id, call);
    return call;
  }

  _enqueueOrRing(call) {
    if (this.dnd) this._moveToPending(call);
    else if (this.activeId || this._ringing()) this._moveToQueued(call);
    else this._startRinging(call);
  }

  _startRinging(call) {
    call.status = 'ringing';
    call.updatedAt = this.now();
    this._clearRingTimer(call.id);
    const timer = setTimeout(() => {
      this.ringTimers.delete(call.id);
      const current = this.calls.get(call.id);
      if (current?.status === 'ringing') {
        this._moveToPending(current);
        this._ringNextIfPossible();
      }
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
    if (this.dnd || this.activeId || this._ringing()) return;
    const next = [...this.calls.values()]
      .filter(c => c.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next) this._startRinging(next);
  }

  _ringing() {
    for (const call of this.calls.values()) if (call.status === 'ringing') return call;
    return null;
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
      detail: call.detail,
      status: call.status,
      snoozedUntil: call.snoozedUntil,
      awaitingClaude: call.awaitingClaude,
      resolved: call.resolved,
      waiting: Boolean(call.responder && !call.resolved),
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
      questionIndex: call.questionIndex || 0,
      questionCount: call.questions?.length || 0,
      // Current question (for quick-answer buttons) while Claude is still waiting for it.
      currentQuestion: call.interactionKind === 'ask' && call.responder && !call.resolved
        ? (({ question, header, multiSelect, options }) => ({ question, header, multiSelect: Boolean(multiSelect), options: (options || []).map(o => ({ label: o.label, description: o.description || '' })) }))(call.questions[call.questionIndex] || {})
        : null,
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

function toolSignature(payload = {}) {
  return `${payload.tool_name || ''}:${stableJson(payload.tool_input || {})}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// ── Spanish answer parsing ───────────────────────────────────────────────────

function normalizeChoice(text) {
  return String(text || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasPhrase(value, phrase) {
  return new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($| )`).test(value);
}

const CLARIFY_START = /^(como|que|cual|cuales|quien|donde|cuando|y si|puedes|podrias|dime|explica|explicame|cuentame|espera|antes|una pregunta|tengo una duda)\b/;
const CLARIFY_ANY = /\b(por que|porque|para que|no entiendo|no lo entiendo|no se|que diferencia|cual es la diferencia|explica|explicame|duda|aclara|aclarame)\b/;

// STT output has no punctuation, so "¿por qué no la primera?" arrives as "porque no la primera".
function isClarification(text) {
  if (/[?¿]/.test(String(text))) return true;
  const value = normalizeChoice(text);
  return CLARIFY_START.test(value) || CLARIFY_ANY.test(value);
}

const ORDINALS = [
  ['1', 'uno', 'primera', 'primero', 'la 1'],
  ['2', 'dos', 'segunda', 'segundo'],
  ['3', 'tres', 'tercera', 'tercero'],
  ['4', 'cuatro', 'cuarta', 'cuarto'],
  ['5', 'cinco', 'quinta', 'quinto'],
];
const FILLER = /^(pues|vale|bueno|venga|eh|em|mm|ok|okay|si|la|el|lo|las|los|opcion|opciones|numero|quiero|prefiero|elijo|escojo|me quedo con|vamos con|ve con|ir con|dale a|dale con|mejor|de|con)\s+/;
const GENERIC_WORDS = new Set(['opcion', 'usar', 'usando', 'mantener', 'crear', 'hacer', 'para', 'como', 'todo', 'todos', 'solo', 'nada', 'actual', 'nuevo', 'nueva', 'otro', 'otra', 'with', 'keep', 'none']);
const RECOMMENDED_ASK = /\b(recomendad[oa]|recomiendas|recomiendes|recomendacion|tu sugerencia|lo que (tu )?digas|la que (tu )?digas|la que (tu )?prefieras|lo que (tu )?prefieras)\b/;
const NEGATION = /(^| )(no|ninguna|ninguno|ni|otra|otro|tampoco|excepto|menos|salvo)( |$)/;

// Maps a short spoken/typed answer onto option labels. Returns null whenever it is not clearly a
// choice, so the caller passes the user's words verbatim instead of inventing a decision.
function matchQuestionAnswer(question, text) {
  const options = Array.isArray(question?.options) ? question.options : [];
  if (!options.length || isClarification(text)) return null;
  let value = normalizeChoice(text);
  if (!value || NEGATION.test(value)) return null;
  let previous;
  do { previous = value; value = value.replace(FILLER, ''); } while (value !== previous);
  const words = value.split(' ').filter(Boolean);
  if (!words.length || words.length > 8) return null;

  // Distinctive words of each label ("supabase", "clerk"): saying one of them picks that option.
  const tokensOf = option => normalizeChoice(labelCore(option.label)).split(' ').filter(w => w.length >= 4 && !GENERIC_WORDS.has(w));
  const optionTokens = options.map(tokensOf);
  const counts = new Map();
  for (const tokens of optionTokens) for (const t of new Set(tokens)) counts.set(t, (counts.get(t) || 0) + 1);
  const wantsRecommended = RECOMMENDED_ASK.test(value);

  const hits = [];
  options.forEach((option, index) => {
    const label = normalizeChoice(option.label);
    const core = normalizeChoice(labelCore(option.label));
    const byLabel = label && (value === label || value === core || (label.length > 1 && (hasPhrase(value, label) || (core.length > 1 && hasPhrase(value, core)))));
    const byOrdinal = (ORDINALS[index] || [String(index + 1)]).some(word => value === word || (words.length <= 5 && hasPhrase(value, word)));
    const byLetter = options.length > 1 && value === 'abcde'[index];
    const byToken = words.length <= 6 && optionTokens[index].some(t => counts.get(t) === 1 && hasPhrase(value, t));
    const byRecommended = wantsRecommended && RECOMMENDED.test(option.label);
    if (byLabel || byOrdinal || byLetter || byToken || byRecommended) hits.push(option.label);
  });

  const unique = [...new Set(hits)];
  if (!unique.length) return null;
  if (question?.multiSelect) return unique.join(', ');
  return unique.length === 1 ? unique[0] : null;
}

const YES = /^(si|vale|ok|okay|okey|claro|venga|dale|adelante|hazlo|haz lo|permitir|permitido|permite|permitelo|autorizo|autorizado|autorizada|acepto|aceptar|aceptado|de acuerdo|por supuesto|sin problema|aprobado|apruebo|apruebalo|correcto|perfecto|afirmativo)\b/;
const NO = /^(no|nope|denegar|deniega|denegado|rechazar|rechaza|rechazado|cancela|cancelar|cancelalo|para|detente|ni hablar|de ninguna manera|mejor no|negativo)\b/;

function parsePermission(text) {
  if (isClarification(text)) return null;
  const value = normalizeChoice(text);
  if (/\b(pero|aunque|depende|espera)\b/.test(value)) return null;
  const yes = YES.test(value);
  const no = NO.test(value);
  if (yes && !no) return 'allow';
  if (no && !yes) return 'deny';
  return null;
}

module.exports = {
  CallBroker,
  CALL_RULES,
  SNOOZE_MINUTES,
  RING_TIMEOUT_MS,
  MIN_RESULT_TURN_MS,
  parsePermission,
  matchQuestionAnswer,
  isClarification,
  compact,
};
