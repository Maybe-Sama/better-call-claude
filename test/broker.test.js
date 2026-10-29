'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CallBroker, parsePermission, matchQuestionAnswer, isClarification } = require('../src/broker');
const { toSpeech } = require('../src/speech-text');

function askPayload(session = 's1', questions) {
  return {
    session_id: session,
    cwd: 'C:\\work\\eureka',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: questions || [{
        question: '¿Qué opción prefieres?',
        header: 'Arquitectura',
        options: [{ label: 'A', description: 'simple' }, { label: 'B', description: 'robusta' }],
        multiSelect: false,
      }],
    },
  };
}

function permissionPayload(session = 'p1', command = 'mkdir demo') {
  return { session_id: session, cwd: 'C:\\work\\web', tool_name: 'Bash', tool_input: { command, description: 'Crear carpeta' } };
}

test('AskUserQuestion rings, answers through updatedInput.answers and waits for Claude', () => {
  const broker = new CallBroker({ defaultMode: 'on', ringTimeoutMs: 1000 });
  let response;
  const call = broker.receiveAskUser(askPayload(), body => { response = body; });
  assert.equal(call.status, 'ringing');
  assert.equal(call.title, 'eureka');
  assert.equal(broker.answer(call.id), true);
  const result = broker.submitUserText(call.id, 'la segunda');
  assert.equal(result.resolved, true);
  const out = response.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'allow');
  assert.equal(out.updatedInput.answers['¿Qué opción prefieres?'], 'B');
  assert.deepEqual(out.updatedInput.questions, askPayload().tool_input.questions);
  assert.equal(broker.getSnapshot().calls[0].awaitingClaude, true);
});

test('a clarification is passed verbatim as the answer (native "Other"), never forced into an option', () => {
  const broker = new CallBroker({ defaultMode: 'on', ringTimeoutMs: 1000 });
  let response;
  const call = broker.receiveAskUser(askPayload('clarify'), body => { response = body; });
  broker.answer(call.id);
  const result = broker.submitUserText(call.id, 'porque no la primera');
  assert.equal(result.clarification, true);
  assert.equal(response.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(response.hookSpecificOutput.updatedInput.answers['¿Qué opción prefieres?'], 'porque no la primera');
});

test('multi-question ask walks through questions and stops early on a clarification', () => {
  const qs = [
    { question: 'Q1', header: 'H1', options: [{ label: 'Rojo' }, { label: 'Azul' }] },
    { question: 'Q2', header: 'H2', options: [{ label: 'Grande' }, { label: 'Pequeño' }] },
    { question: 'Q3', header: 'H3', options: [{ label: 'Sí' }, { label: 'No' }] },
  ];
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  let response;
  const call = broker.receiveAskUser(askPayload('multi', qs), body => { response = body; });
  broker.answer(call.id);
  assert.equal(broker.submitUserText(call.id, 'azul').nextQuestion, true);
  assert.equal(response, undefined);
  broker.submitUserText(call.id, '¿qué diferencia hay?');
  const answers = response.hookSpecificOutput.updatedInput.answers;
  assert.equal(answers.Q1, 'Azul');
  assert.equal(answers.Q2, '¿qué diferencia hay?');
  assert.match(answers.Q3, /sin responder/);
});

test('choice matcher: ordinals, labels, fillers; ambiguous or negated answers stay verbatim', () => {
  const q = askPayload().tool_input.questions[0];
  assert.equal(matchQuestionAnswer(q, 'la segunda'), 'B');
  assert.equal(matchQuestionAnswer(q, 'El hijo la segunda opción'), 'B');
  assert.equal(matchQuestionAnswer(q, 'A'), 'A');
  assert.equal(matchQuestionAnswer(q, 'quiero B'), 'B');
  assert.equal(matchQuestionAnswer(q, 'tengo una duda'), null);
  assert.equal(matchQuestionAnswer(q, 'no la segunda'), null);
  assert.equal(matchQuestionAnswer(q, 'la primera o la segunda'), null);
  const colors = { options: [{ label: 'Rojo' }, { label: 'Azul' }] };
  assert.equal(matchQuestionAnswer(colors, 'me quedo con el azul'), 'Azul');
  assert.equal(matchQuestionAnswer(colors, 'pues rojo'), 'Rojo');
  const multi = { multiSelect: true, options: [{ label: 'Tests' }, { label: 'Docs' }, { label: 'CI' }] };
  assert.equal(matchQuestionAnswer(multi, 'tests y ci'), 'Tests, CI');
});

test('clarification detector handles unpunctuated STT output', () => {
  assert.equal(isClarification('porque no la primera'), true);
  assert.equal(isClarification('¿por qué no la primera?'), true);
  assert.equal(isClarification('para que sirve eso'), true);
  assert.equal(isClarification('la segunda'), false);
});

test('final Stop call can receive a spoken follow-up and continue Claude via additionalContext', () => {
  const broker = new CallBroker({ defaultMode: 'on', ringTimeoutMs: 1000 });
  let response;
  const call = broker.receiveCompletion({ session_id: 's2', cwd: 'C:/work/web', last_assistant_message: 'La página está terminada.' }, { responder: body => { response = body; } });
  broker.answer(call.id);
  const result = broker.submitUserText(call.id, 'Ábreme la web para verla');
  assert.equal(result.continued, true);
  assert.equal(response.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(response.hookSpecificOutput.additionalContext, /Ábreme la web/);
});

test('the next Stop of the same session merges into the active call instead of ringing again', () => {
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  const call = broker.receiveCompletion({ session_id: 'loop', last_assistant_message: 'Hecho.' }, { responder: () => {} });
  broker.answer(call.id);
  broker.submitUserText(call.id, 'ábreme la web');
  let second;
  const merged = broker.receiveCompletion({ session_id: 'loop', stop_hook_active: true, last_assistant_message: 'Abierta.' }, { responder: body => { second = body; } });
  assert.equal(merged.id, call.id);
  assert.equal(merged.status, 'active');
  assert.equal(merged.awaitingClaude, false);
  broker.hangup(call.id);
  assert.deepEqual(second, {});
});

test('hanging up a completion call means done and lets Stop finish', () => {
  const broker = new CallBroker({ defaultMode: 'on', ringTimeoutMs: 1000 });
  let response = null;
  const call = broker.receiveCompletion({ session_id: 's3', last_assistant_message: 'He terminado.' }, { responder: body => { response = body; } });
  broker.answer(call.id);
  broker.hangup(call.id);
  assert.deepEqual(response, {});
  assert.equal(broker.getSnapshot().calls.length, 0);
});

test('short routine turns release Stop immediately without ringing', () => {
  let t = 1_000;
  const broker = new CallBroker({ defaultMode: 'on', now: () => t, minResultMs: 20_000 });
  broker.notePrompt({ session_id: 'quick', prompt: 'hola' });
  t += 3_000;
  let response;
  const call = broker.receiveCompletion({ session_id: 'quick', last_assistant_message: 'Hola.' }, { responder: body => { response = body; } });
  assert.equal(call, null);
  assert.deepEqual(response, {});
  assert.equal(broker.getSnapshot().calls.length, 0);

  broker.notePrompt({ session_id: 'quick', prompt: 'implementa la web' });
  t += 60_000;
  assert.equal(broker.receiveCompletion({ session_id: 'quick', last_assistant_message: 'Lista.' }, { responder: () => {} }).status, 'ringing');
});

test('a short turn that needed a question still produces a result call', () => {
  let t = 1_000;
  const broker = new CallBroker({ defaultMode: 'on', now: () => t, minResultMs: 20_000 });
  broker.notePrompt({ session_id: 'q', prompt: 'haz algo' });
  const ask = broker.receiveAskUser(askPayload('q'), () => {});
  broker.answer(ask.id);
  broker.submitUserText(ask.id, 'A');
  broker.hangup(ask.id);
  t += 2_000;
  assert.ok(broker.receiveCompletion({ session_id: 'q', last_assistant_message: 'Hecho.' }, { responder: () => {} }));
});

test('typing in the terminal releases a held Stop so Claude Code stays usable', () => {
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  let response;
  const call = broker.receiveCompletion({ session_id: 'term', last_assistant_message: 'Listo.' }, { responder: body => { response = body; } });
  assert.equal(call.status, 'ringing');
  broker.notePrompt({ session_id: 'term', prompt: 'otra cosa' });
  assert.deepEqual(response, {});
  assert.equal(broker.getSnapshot().calls.length, 0);
});

test('a permission answered in the terminal is cleared when the matching PostToolUse arrives', () => {
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  let response;
  const call = broker.receivePermission(permissionPayload('pt'), body => { response = body; });
  broker.noteToolDone({ session_id: 'pt', tool_name: 'Bash', tool_input: { command: 'other' } });
  assert.equal(broker.calls.has(call.id), true);
  broker.noteToolDone({ session_id: 'pt', tool_name: 'Bash', tool_input: { description: 'Crear carpeta', command: 'mkdir demo' } });
  assert.deepEqual(response, {});
  assert.equal(broker.calls.has(call.id), false);
});

test('a new request from the same session supersedes an older held one', () => {
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  let first;
  const old = broker.receivePermission(permissionPayload('sup', 'a'), body => { first = body; });
  const next = broker.receivePermission(permissionPayload('sup', 'b'), () => {});
  assert.deepEqual(first, {});
  assert.equal(broker.calls.has(old.id), false);
  assert.equal(next.status, 'ringing');
});

test('an aborted hook request cancels its call', () => {
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  const call = broker.receivePermission(permissionPayload('ab'), () => {});
  assert.equal(broker.cancel(call.id), true);
  assert.equal(broker.calls.has(call.id), false);
});

test('permission requests for AskUserQuestion are ignored (handled by PreToolUse)', () => {
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  let response;
  assert.equal(broker.receivePermission({ session_id: 'x', tool_name: 'AskUserQuestion', tool_input: {} }, b => { response = b; }), null);
  assert.deepEqual(response, {});
});

test('permission: yes/no/clarification produce the documented PermissionRequest decisions', () => {
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  let response;
  let call = broker.receivePermission(permissionPayload('perm1'), b => { response = b; });
  broker.answer(call.id);
  broker.submitUserText(call.id, 'sí, adelante');
  assert.deepEqual(response.hookSpecificOutput, { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } });
  broker.hangup(call.id);

  call = broker.receivePermission(permissionPayload('perm2'), b => { response = b; });
  broker.answer(call.id);
  broker.submitUserText(call.id, '¿para qué necesitas eso?');
  assert.equal(response.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(response.hookSpecificOutput.decision.message, /para qué necesitas/);
});

test('a second session is queued while another call is active, and rings after hangup', () => {
  const broker = new CallBroker({ defaultMode: 'on', ringTimeoutMs: 1000 });
  const first = broker.receiveAskUser(askPayload('s1'), () => {});
  broker.answer(first.id);
  const second = broker.receiveAskUser(askPayload('s2'), () => {});
  assert.equal(second.status, 'queued');
  assert.equal(broker.getSnapshot().counts.queued, 1);
  broker.submitUserText(first.id, 'A');
  broker.hangup(first.id);
  assert.equal(second.status, 'ringing');
});

test('only one call rings at a time; the next one waits in the queue', () => {
  const broker = new CallBroker({ defaultMode: 'on', ringTimeoutMs: 1000 });
  const a = broker.receiveAskUser(askPayload('r1'), () => {});
  const b = broker.receiveAskUser(askPayload('r2'), () => {});
  assert.equal(a.status, 'ringing');
  assert.equal(b.status, 'queued');
  broker.snooze(a.id, 5);
  assert.equal(b.status, 'ringing');
});

test('DND routes new calls to pending silently', () => {
  const broker = new CallBroker({ defaultMode: 'on', ringTimeoutMs: 1000 });
  broker.setDnd(true);
  const call = broker.receiveAskUser(askPayload('s4'), () => {});
  assert.equal(call.status, 'pending');
});

test('ring timeout moves call to pending and rings the next queued call', async () => {
  const broker = new CallBroker({ defaultMode: 'on', ringTimeoutMs: 20 });
  const call = broker.receiveAskUser(askPayload('s5'), () => {});
  const next = broker.receiveAskUser(askPayload('s6'), () => {});
  assert.equal(call.status, 'ringing');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(broker.getSnapshot().calls.find(c => c.id === call.id).status, 'pending');
  assert.equal(next.status, 'ringing');
});

test('a pending call can be called back and still answers the held hook', () => {
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  let response;
  const call = broker.receiveCompletion({ session_id: 'cb', last_assistant_message: 'Terminado.' }, { responder: b => { response = b; } });
  broker._moveToPending(call);
  assert.equal(broker.answer(call.id), true);
  broker.submitUserText(call.id, 'añade un test');
  assert.match(response.hookSpecificOutput.additionalContext, /añade un test/);
});

test('snooze accepts only the configured values', () => {
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  const call = broker.receiveAskUser(askPayload('sn'), () => {});
  assert.equal(broker.snooze(call.id, 11), false);
  for (const m of [1, 10, 15, 20, 30, 45, 60, 120]) assert.equal(broker.snooze(call.id, m), true);
  assert.equal(call.status, 'snoozed');
});

test('StopFailure creates an informational error call', () => {
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  const call = broker.receiveCompletion({ session_id: 'err', error: 'rate_limit' }, { failure: true });
  assert.equal(call.type, 'error');
  assert.equal(call.interactionKind, null);
  assert.match(call.messages[0].text, /rate_limit/);
});

test('incoming call context prefers the session title, then a meaningful prompt', () => {
  const broker = new CallBroker({ defaultMode: 'on', readTitle: p => (p === 'with-title.jsonl' ? 'Rediseñar el panel de alumnos' : '') });
  broker.notePrompt({ session_id: 'c1', prompt: 'Implementa el login con Supabase y tests de integración' });
  broker.notePrompt({ session_id: 'c1', prompt: 'sí' });
  const a = broker.receiveAskUser({ ...askPayload('c1') }, () => {});
  assert.equal(a.context, 'Implementa el login con Supabase y tests de integración');
  const b = broker.receiveAskUser({ ...askPayload('c2'), transcript_path: 'with-title.jsonl' }, () => {});
  assert.equal(b.context, 'Rediseñar el panel de alumnos');
});

test('permission parser accepts natural Spanish yes/no and keeps doubts as clarifications', () => {
  assert.equal(parsePermission('Sí, adelante'), 'allow');
  assert.equal(parsePermission('vale, hazlo'), 'allow');
  assert.equal(parsePermission('Sí.'), 'allow');
  assert.equal(parsePermission('No, no lo hagas'), 'deny');
  assert.equal(parsePermission('depende'), null);
  assert.equal(parsePermission('sí, pero explícame antes qué hace'), null);
  assert.equal(parsePermission('para qué es eso'), null);
  assert.equal(parsePermission('no sé'), null);
});

test('toSpeech reads the first spoken-style paragraph without markdown noise', () => {
  const md = 'He terminado la **landing** de `eureka`: compila y los tests pasan.\n\n## Detalle\n- `src/app.js` cambiado\n\n```js\nconsole.log(1)\n```';
  const spoken = toSpeech(md);
  assert.match(spoken, /^He terminado la landing de eureka: compila y los tests pasan\./);
  assert.doesNotMatch(spoken, /[`*#]/);
  assert.doesNotMatch(spoken, /pantalla|Detalle/);
  assert.equal(toSpeech('Hecho.'), 'Hecho.');
});

test('toSpeech also reads closing paragraphs that ask the user something, skipping the detail list', () => {
  const md = 'El vídeo está terminado y te he abierto la carpeta.\n\nCómo está hecho:\n- La partida: 233 tiradas.\n- El final: bucle sin salto.\n\nNecesito permiso para gastar en ElevenLabs.\n\nMíralo y dime qué cambiarías.';
  const spoken = toSpeech(md);
  assert.match(spoken, /^El vídeo está terminado/);
  assert.match(spoken, /permiso para gastar en ElevenLabs\. Míralo y dime qué cambiarías\.$/);
  assert.doesNotMatch(spoken, /233 tiradas/);
  assert.doesNotMatch(toSpeech('Hecho.\n\n- detalle\n\nTodo compila.'), /Todo compila/);
});

test('choice matcher handles typical Claude labels: keywords, letters and "la recomendada"', () => {
  const q = { question: '¿Qué autenticación usamos?', options: [
    { label: 'Supabase Auth (Recomendado)', description: 'Ya usas Supabase' },
    { label: 'NextAuth', description: 'Más control' },
    { label: 'Clerk', description: 'De pago a partir de cierto uso' },
  ] };
  assert.equal(matchQuestionAnswer(q, 'Supabase'), 'Supabase Auth (Recomendado)');
  assert.equal(matchQuestionAnswer(q, 'vamos con Clerk'), 'Clerk');
  assert.equal(matchQuestionAnswer(q, 'la que recomiendas'), 'Supabase Auth (Recomendado)');
  assert.equal(matchQuestionAnswer(q, 'la B'), 'NextAuth');
  assert.equal(matchQuestionAnswer(q, 'la tercera'), 'Clerk');
  assert.equal(matchQuestionAnswer(q, 'Clerk o NextAuth, no sé'), null);
});

test('quick-answer buttons: option labels, multi-select and Sí/No on permissions', () => {
  const qs = [
    { question: 'Q1', header: 'Login', options: [{ label: 'Supabase Auth (Recomendado)' }, { label: 'NextAuth' }, { label: 'Clerk' }] },
    { question: 'Q2', header: 'Métodos', multiSelect: true, options: [{ label: 'Email y contraseña' }, { label: 'Google' }, { label: 'Enlace mágico' }] },
  ];
  const broker = new CallBroker({ defaultMode: 'on', defaultMode: 'on' });
  let response;
  const call = broker.receiveAskUser(askPayload('btn', qs), b => { response = b; });
  broker.answer(call.id);
  assert.deepEqual(broker.getSnapshot().calls[0].currentQuestion.options.map(o => o.label), ['Supabase Auth (Recomendado)', 'NextAuth', 'Clerk']);
  assert.equal(broker.submitChoice(call.id, 'No existe').ok, false);
  assert.equal(broker.submitChoice(call.id, 'NextAuth').nextQuestion, true);
  assert.equal(broker.getSnapshot().calls[0].currentQuestion.multiSelect, true);
  broker.submitChoice(call.id, ['Google', 'Enlace mágico']);
  assert.deepEqual(response.hookSpecificOutput.updatedInput.answers, { Q1: 'NextAuth', Q2: 'Google, Enlace mágico' });
  assert.equal(broker.getSnapshot().calls[0].currentQuestion, null);

  let permission;
  const p = broker.receivePermission(permissionPayload('btn2'), b => { permission = b; });
  broker.hangup(call.id);
  broker.answer(p.id);
  broker.submitChoice(p.id, 'allow');
  assert.equal(permission.hookSpecificOutput.decision.behavior, 'allow');
});

test('/better-call-saul on|off toggles calls per session; off sessions never ring', () => {
  const broker = new CallBroker(); // default: off
  let response;
  assert.equal(broker.receiveAskUser(askPayload('m1'), b => { response = b; }), null);
  assert.deepEqual(response, {});

  const ctxOn = broker.notePrompt({ session_id: 'm1', prompt: '/better-call-saul on' });
  assert.match(ctxOn, /ACTIVADAS/);
  assert.match(ctxOn, /AskUserQuestion/);
  assert.equal(broker.receiveAskUser(askPayload('m1'), () => {}).status, 'ringing');
  assert.equal(broker.receiveAskUser(askPayload('other'), () => {}), null);

  let held;
  const stop = broker.receiveCompletion({ session_id: 'm2', last_assistant_message: 'x' }, { responder: b => { held = b; }, hint: 'on' });
  assert.ok(stop);
  assert.match(broker.notePrompt({ session_id: 'm2', prompt: '/agentcall:better-call-saul off' }), /DESACTIVADAS/);
  assert.deepEqual(held, {});
  assert.equal(broker.receiveCompletion({ session_id: 'm2', last_assistant_message: 'y' }, { responder: () => {}, hint: 'on' }), null);
  assert.match(broker.notePrompt({ session_id: 'm2', prompt: '/better-call-saul' }), /DESACTIVADAS/);

  const restored = new CallBroker();
  restored.importPersistentState(broker.exportPersistentState());
  assert.equal(restored.sessionMode('m1'), 'on');
  assert.equal(restored.sessionMode('m2', 'on'), 'off');
  assert.equal(restored.sessionStartContext({ session_id: 'new' }, 'on') !== null, true);
  assert.equal(restored.sessionStartContext({ session_id: 'new' }), null);
});

test('the confirmation turn of /better-call-saul on does not ring', () => {
  const broker = new CallBroker();
  broker.notePrompt({ session_id: 'q1', prompt: '/better-call-saul on' });
  let response;
  assert.equal(broker.receiveCompletion({ session_id: 'q1', last_assistant_message: 'Llamadas activadas.' }, { responder: b => { response = b; } }), null);
  assert.deepEqual(response, {});
  assert.ok(broker.receiveCompletion({ session_id: 'q1', last_assistant_message: 'Trabajo hecho.' }, { responder: () => {} }));
});
