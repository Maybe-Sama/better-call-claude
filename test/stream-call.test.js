const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CallBroker } = require('../src/broker');
const { StreamCallController, VOICE_CALL_RULES } = require('../src/voice/stream-call');

// Fake StreamSession (src/voice/stream-session.js API) recording what AgentCall asks of Claude.
class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.sessionId = 'sess-1';
    this.sent = [];
    this.decisions = [];
    this.interrupts = 0;
    this.closed = false;
    this.busy = false;
  }
  async start() { return this; }
  send(text) { this.sent.push(text); return `u${this.sent.length}`; }
  async sendUrgent(text) { this.interrupts += 1; this.sent.push(text); return `u${this.sent.length}`; }
  allow(requestId, input) { this.decisions.push({ requestId, allow: true, input }); }
  deny(requestId, message) { this.decisions.push({ requestId, allow: false, message }); }
  async close() { this.closed = true; }
  turn(deltas) {
    this.busy = true;
    this.emit('turn-start');
    for (const delta of deltas) this.emit('text', { delta });
    this.emit('assistant-message', { text: deltas.join('') });
    this.busy = false;
    this.emit('turn-end', { terminalReason: 'completed', aborted: false });
  }
}

// Splits on ". " (the real SpeechChunker handles markdown).
const chunker = () => {
  let buf = '';
  return {
    push(d) { buf += d; const out = []; let i; while ((i = buf.indexOf('. ')) >= 0) { out.push(buf.slice(0, i + 1)); buf = buf.slice(i + 2); } return out; },
    finish() { const rest = buf.trim(); buf = ''; return rest; },
  };
};

function setup() {
  const broker = new CallBroker({ defaultMode: 'off' });
  const spoken = [];
  const voice = {
    turnStarts: 0,
    messageStarts: 0,
    streamTurnStart() { this.turnStarts += 1; },
    streamMessageStart() { this.messageStarts += 1; },
    streamSentence(s) { spoken.push(s); },
    streamTurnEnd() { spoken.push('<end>'); },
  };
  const session = new FakeSession();
  const ctl = new StreamCallController({ broker, voice, createSession: () => session, createChunker: chunker });
  return { broker, voice, session, ctl, spoken };
}

test('starting a controlled call opens it active and greets the user', async () => {
  const { broker, ctl } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  assert.equal(broker.activeId, call.id);
  const msgs = broker.getSnapshot().calls[0].messages;
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].text, 'Dime.');
  assert.equal(ctl.owns(call.id), true);
});

test('Claude\'s streamed text is spoken sentence by sentence and kept (silent) in the call', async () => {
  const { broker, ctl, session, spoken, voice } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.turn(['Google fun', 'ciona. Apple ', 'falla por la configuración.']);
  assert.equal(voice.turnStarts, 1);
  assert.deepEqual(spoken, ['Google funciona.', 'Apple falla por la configuración.', '<end>']);
  const last = broker.getSnapshot().calls.find(c => c.id === call.id).messages.at(-1);
  assert.equal(last.silent, true);
  assert.equal(broker.getSnapshot().calls[0].waiting, true, 'Claude idle again: waiting for the user');
});

test('the controlled session is told it is on a voice call (its AgentCall hooks are off)', async () => {
  const broker = new CallBroker({ defaultMode: 'off' });
  const seen = [];
  const ctl = new StreamCallController({ broker, voice: {}, createChunker: chunker, createSession: (o) => { seen.push(o); return new FakeSession(); } });
  await ctl.start({ cwd: 'C:/work/app', resume: 'r1' });
  assert.equal(seen[0].cwd, 'C:/work/app');
  assert.equal(seen[0].resume, 'r1');
  assert.equal(seen[0].appendSystemPrompt, VOICE_CALL_RULES);
  assert.match(VOICE_CALL_RULES, /read aloud/);
  assert.match(VOICE_CALL_RULES, /no markdown/i);
});

test('the answer Claude writes after using a tool is spoken too', async () => {
  const { ctl, session, spoken } = setup();
  await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  session.emit('turn-start');
  session.emit('assistant-start', { messageId: 'm1' });
  session.emit('text', { delta: 'Voy a mirar el login' });
  session.emit('tool', { name: 'Read', toolUseId: 't1' });
  session.emit('assistant-start', { messageId: 'm2' });
  session.emit('text', { delta: 'Ya está. El fallo era la configuración' });
  session.busy = false;
  session.emit('turn-end', { terminalReason: 'completed', aborted: false });
  assert.deepEqual(spoken, ['Voy a mirar el login', 'Ya está.', 'El fallo era la configuración', '<end>']);
});

test('what the user says goes to Claude; a correction while it works interrupts first', async () => {
  const { ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  assert.deepEqual(ctl.say(call.id, 'Prueba el login.', 'queue'), { ok: true, route: 'answer', stream: true, queued: false });
  session.busy = true;
  const r = ctl.say(call.id, 'Ah, y también Apple.', 'queue');
  assert.equal(r.route, 'steer');
  assert.equal(session.interrupts, 0, 'an addition does not interrupt');
  ctl.say(call.id, 'No, para, eso no.', 'interrupt');
  assert.equal(session.interrupts, 1);
  assert.deepEqual(session.sent, ['Prueba el login.', 'Ah, y también Apple.', 'No, para, eso no.']);
});

test('a queued message shows as delivered once Claude takes it', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  ctl.say(call.id, 'Y añade tests.', 'queue');
  const msg = () => broker.getSnapshot().calls[0].messages.find(m => m.text === 'Y añade tests.');
  assert.equal(msg().delivered, false);
  session.emit('message', { uuid: 'u1', state: 'started' });
  assert.equal(msg().delivered, true);
});

test('a permission is asked in the call and the spoken answer reaches Claude', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  broker.setStreamBusy(call.id, true);
  session.emit('permission', { requestId: 'p1', toolName: 'Bash', input: { command: 'npm test' } });
  assert.equal(broker.getSnapshot().calls[0].interactionKind, 'permission');
  broker.submitUserText(call.id, 'sí');
  assert.deepEqual(session.decisions, [{ requestId: 'p1', allow: true, input: { command: 'npm test' } }]);
  session.emit('permission', { requestId: 'p2', toolName: 'Bash', input: { command: 'rm -rf /' } });
  broker.submitUserText(call.id, 'no');
  assert.equal(session.decisions[1].allow, false);
});

test('AskUserQuestion is answered by voice with the chosen option', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  const input = { questions: [{ question: '¿Qué base de datos?', header: 'BD', options: [{ label: 'Supabase' }, { label: 'Neon' }], multiSelect: false }] };
  session.emit('permission', { requestId: 'q1', toolName: 'AskUserQuestion', input });
  assert.equal(broker.getSnapshot().calls[0].interactionKind, 'ask');
  broker.submitUserText(call.id, 'la segunda');
  assert.equal(session.decisions[0].allow, true);
  assert.equal(session.decisions[0].input.answers['¿Qué base de datos?'], 'Neon');
});

// Live test: "he dado varias veces a colgar y se ha puesto en espera, pero la última se ha cerrado del todo".
test('hanging up while Claude is idle keeps the conversation a while, then closes it', async () => {
  const broker = new CallBroker({ defaultMode: 'off', streamGraceMs: 30 });
  const session = new FakeSession();
  const ctl = new StreamCallController({ broker, voice: { streamTurnStart() {}, streamSentence() {}, streamTurnEnd() {} }, createSession: () => session, createChunker: chunker });
  const call = await ctl.start({ cwd: 'C:/work/app' });
  broker.hangup(call.id);
  await new Promise(r => setImmediate(r));
  assert.equal(session.closed, false, 'one click brings it back');
  assert.equal(broker.getSnapshot().calls[0].status, 'ended');
  assert.equal(broker.answer(call.id), true);
  assert.equal(ctl.say(call.id, 'Una cosa más.', 'queue').ok, true);
  session.busy = false;
  session.emit('turn-start');
  session.emit('turn-end', { terminalReason: 'completed', aborted: false });
  broker.hangup(call.id);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(session.closed, true, 'closed after the grace period');
  assert.equal(ctl.owns(call.id), false);
});

// Live test 2026-11-02: "he colgado a ver si me vuelve a llamar cuando termine la tarea".
test('hanging up while Claude works lets it go on, and it calls back with the result', async () => {
  const { broker, ctl, session, spoken } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  ctl.say(call.id, 'Compila toda la web.', 'queue');
  session.busy = true;
  session.emit('turn-start');
  session.emit('text', { delta: 'Voy a ello. ' });
  broker.hangup(call.id);
  await new Promise(r => setImmediate(r));
  assert.equal(session.closed, false, 'Claude keeps working');
  assert.equal(broker.activeId, null);
  assert.equal(broker.getSnapshot().calls[0].status, 'parked');
  session.emit('text', { delta: 'Ya está compilada. ' });
  session.emit('assistant-message', { text: 'Ya está compilada. Todo **funciona**.' });
  assert.ok(!spoken.some(s => /compilada/.test(s)), 'nobody is on the line: nothing is spoken');
  session.busy = false;
  session.emit('turn-end', { terminalReason: 'completed', aborted: false });
  const pub = broker.getSnapshot().calls[0];
  assert.equal(pub.status, 'ringing', 'Claude calls back');
  const last = pub.messages.at(-1);
  assert.ok(!last.silent, 'heard when the user picks up');
  assert.equal(last.speech, 'Ya está compilada. Todo funciona.');
  assert.equal(broker.answer(call.id), true);
  assert.equal(broker.getSnapshot().calls[0].waiting, true, 'the conversation goes on');
  assert.equal(ctl.say(call.id, 'Gracias, ahora súbela.', 'queue').ok, true);
});

test('a permission Claude needs while the user hung up rings with the question', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  broker.setStreamBusy(call.id, true);
  broker.hangup(call.id);
  session.emit('permission', { requestId: 'p3', toolName: 'Bash', input: { command: 'npm run build' } });
  const pub = broker.getSnapshot().calls;
  assert.equal(pub.length, 1, 'the same call, not a second one');
  assert.equal(pub[0].status, 'ringing');
  assert.equal(pub[0].interactionKind, 'permission');
  broker.answer(call.id);
  broker.submitUserText(call.id, 'sí');
  assert.deepEqual(session.decisions, [{ requestId: 'p3', allow: true, input: { command: 'npm run build' } }]);
});

// "¿Cómo pongo la llamada en espera para irme a otra llamada sin cerrar y recuperar?"
// "Falta que me llame cuando esté en listo": on hold it does not ring while Claude works, it does when done.
test('on hold: nothing closes, it rings when Claude is done, and picking it up again goes on', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  ctl.say(call.id, 'Revisa el login.', 'queue');
  session.busy = true;
  session.emit('turn-start');
  assert.equal(broker.hold(call.id), true);
  await new Promise(r => setImmediate(r));
  assert.equal(session.closed, false);
  assert.equal(broker.activeId, null);
  assert.equal(broker.getSnapshot().calls[0].status, 'onhold');
  session.emit('assistant-message', { text: 'El login ya funciona.' });
  session.busy = false;
  session.emit('turn-end', { terminalReason: 'completed', aborted: false });
  const pub = broker.getSnapshot().calls[0];
  assert.equal(pub.status, 'ringing', 'Claude is done: it calls back');
  assert.equal(pub.messages.at(-1).speech, 'El login ya funciona.', 'heard on pick-up');
  assert.equal(broker.answer(call.id), true);
  assert.equal(ctl.say(call.id, 'Perfecto, súbelo.', 'queue').ok, true);
  session.busy = true;
  session.emit('turn-start');
  broker.hold(call.id);
  assert.equal(broker.getSnapshot().calls[0].status, 'onhold', 'no ring while Claude works');
  session.busy = false;
  session.emit('turn-end', { terminalReason: 'completed', aborted: false });
  broker.answer(call.id);
  // Idle Claude, on hold again: still nothing closes.
  broker.hold(call.id);
  await new Promise(r => setImmediate(r));
  assert.equal(session.closed, false);
});

test('putting a call on hold lets a waiting call ring', async () => {
  const { broker, ctl } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  broker.receivePermission({ session_id: 'other', cwd: 'C:/work/api', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  assert.equal(broker.getSnapshot().calls.find(c => c.sessionId === 'other').status, 'queued');
  broker.hold(call.id);
  assert.equal(broker.getSnapshot().calls.find(c => c.sessionId === 'other').status, 'ringing');
});

test('a prompt while on hold rings that same call', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  broker.setStreamBusy(call.id, true);
  broker.hold(call.id);
  session.emit('permission', { requestId: 'p4', toolName: 'Bash', input: { command: 'npm test' } });
  const pub = broker.getSnapshot().calls;
  assert.equal(pub.length, 1);
  assert.equal(pub[0].status, 'ringing');
  assert.equal(pub[0].interactionKind, 'permission');
  broker.answer(call.id);
  broker.submitUserText(call.id, 'sí');
  assert.equal(session.decisions[0].allow, true);
});

// Live test: "no me ha dejado poner en espera una llamada" (a /saul on session's result call).
test('a hook call on hold keeps Claude waiting for its answer, never rings, and is picked up again', () => {
  const broker = new CallBroker({ defaultMode: 'off' });
  const answers = [];
  const c = broker.receivePermission({ session_id: 's9', cwd: 'C:/x', tool_name: 'Bash', tool_input: { command: 'npm test' } }, (body) => { answers.push(body); return true; }, 'on');
  broker.answer(c.id);
  assert.equal(broker.hold(c.id), true);
  assert.equal(broker.activeId, null);
  assert.equal(broker.getSnapshot().calls[0].status, 'onhold');
  assert.equal(answers.length, 0, 'Claude still waits for the answer');
  assert.equal(broker.answer(c.id), true);
  broker.submitUserText(c.id, 'sí');
  assert.equal(answers[0].hookSpecificOutput.decision.behavior, 'allow');
});

test('a hook call on hold: what the session asks next goes into it and rings it', () => {
  const broker = new CallBroker({ defaultMode: 'off' });
  const c = broker.receivePermission({ session_id: 's8', cwd: 'C:/x', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  broker.answer(c.id);
  broker.hold(c.id);
  // Claude moved on (answered in the terminal) and asks something else.
  broker.receiveAskUser({ session_id: 's8', cwd: 'C:/x', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '¿Supabase o Neon?', header: 'BD', options: [{ label: 'Supabase' }, { label: 'Neon' }], multiSelect: false }] } }, () => true, 'on');
  const calls = broker.getSnapshot().calls;
  assert.equal(calls.length, 1, 'no second call');
  assert.equal(calls[0].status, 'ringing');
  assert.equal(calls[0].interactionKind, 'ask');
});

test('a hook call on hold rings with the result when Claude is done; never in the middle of another call', () => {
  const broker = new CallBroker({ defaultMode: 'off' });
  const c = broker.receiveCompletion({ session_id: 's7', cwd: 'C:/x', last_assistant_message: 'He cambiado el logo.', stop_hook_active: true }, { responder: () => true, hint: 'on' });
  broker.answer(c.id);
  broker.submitUserText(c.id, 'Ahora ponlo en el pie también.'); // Claude works again
  broker.hold(c.id);
  const other = broker.receivePermission({ session_id: 'o1', cwd: 'C:/y', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  broker.answer(other.id); // the user is in another call
  broker.receiveCompletion({ session_id: 's7', cwd: 'C:/x', last_assistant_message: 'Listo, también en el pie.' }, { responder: () => true, hint: 'on' });
  const held = broker.getSnapshot().calls.find(x => x.id === c.id);
  assert.equal(held.status, 'queued', 'waits for the other call to end');
  assert.equal(held.messages.at(-1).text, 'Listo, también en el pie.');
  broker.hangup(other.id);
  assert.equal(broker.getSnapshot().calls.find(x => x.id === c.id).status, 'ringing');
});

// ── Review round 4 ──────────────────────────────────────────────────────────────────────────

test('a held hook call is over once the user goes on in the terminal; short replies never ring (#1)', () => {
  const broker = new CallBroker({ defaultMode: 'off' });
  const answers = [];
  const c = broker.receiveCompletion({ session_id: 'h1', cwd: 'C:/x', last_assistant_message: 'He terminado.', stop_hook_active: true }, { responder: (b) => { answers.push(b); return true; }, hint: 'on' });
  broker.answer(c.id);
  broker.hold(c.id);
  broker.notePrompt({ session_id: 'h1', prompt: '¿qué hora es?' }, 'on'); // typed in the terminal
  assert.equal(broker.getSnapshot().calls.length, 0, 'the held call is gone');
  assert.equal(answers.length, 1, 'what it held was released');
  const late = [];
  broker.receiveCompletion({ session_id: 'h1', cwd: 'C:/x', last_assistant_message: 'Son las doce.' }, { responder: (b) => { late.push(b); return true; }, hint: 'on' });
  assert.equal(broker.getSnapshot().calls.length, 0, 'a quick answer in the terminal does not ring');
  assert.equal(late.length, 1);
});

test('a held hook call does not catch the confirmation of /saul (#1)', () => {
  const broker = new CallBroker({ defaultMode: 'off' });
  const c = broker.receivePermission({ session_id: 'h2', cwd: 'C:/x', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  broker.answer(c.id);
  broker.submitUserText(c.id, 'sí'); // Claude works
  broker.hold(c.id);
  broker.notePrompt({ session_id: 'h2', prompt: '/saul status' }, 'on');
  const held = [];
  broker.receiveCompletion({ session_id: 'h2', cwd: 'C:/x', last_assistant_message: 'Llamadas activadas.' }, { responder: (b) => { held.push(b); return true; }, hint: 'on' });
  assert.equal(held.length, 1, 'answered at once, not held');
  assert.equal(broker.getSnapshot().calls.length, 0);
});

test('a held hook call whose request Claude dropped is removed (#1)', () => {
  const broker = new CallBroker({ defaultMode: 'off' });
  const c = broker.receivePermission({ session_id: 'h3', cwd: 'C:/x', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  broker.answer(c.id);
  broker.hold(c.id);
  broker.cancel(c.id); // answered in the terminal / Claude interrupted
  assert.equal(broker.getSnapshot().calls.length, 0);
});

test('the queue rings in the order calls joined it (#10)', () => {
  let now = 1000;
  const broker = new CallBroker({ defaultMode: 'off', now: () => now });
  const a = broker.receivePermission({ session_id: 'q1', cwd: 'C:/a', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  broker.answer(a.id);
  broker.submitUserText(a.id, 'sí');
  broker.hold(a.id); // created first, but not queued yet
  const b = broker.receivePermission({ session_id: 'q2', cwd: 'C:/b', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  broker.answer(b.id);
  now += 1000;
  const c = broker.receivePermission({ session_id: 'q3', cwd: 'C:/c', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  now += 1000;
  broker.receiveCompletion({ session_id: 'q1', cwd: 'C:/a', last_assistant_message: 'Hecho.', stop_hook_active: true }, { responder: () => true, hint: 'on' });
  broker.hangup(b.id);
  assert.equal(broker.getSnapshot().calls.find(x => x.id === c.id).status, 'ringing', 'queued earlier, rings first');
});

test('putting a hook call on hold lets another session\'s call ring', () => {
  const broker = new CallBroker({ defaultMode: 'off' });
  const a = broker.receivePermission({ session_id: 'sa', cwd: 'C:/a', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  broker.answer(a.id);
  broker.receivePermission({ session_id: 'sb', cwd: 'C:/b', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  broker.hold(a.id);
  assert.equal(broker.getSnapshot().calls.find(c => c.sessionId === 'sb').status, 'ringing');
});

test('a prompt Claude withdraws while the user is away never ends the conversation', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  broker.setStreamBusy(call.id, true);
  session.emit('permission', { requestId: 'p6', toolName: 'Bash', input: { command: 'npm test' } });
  broker.hangup(call.id); // unanswered: Pendientes
  session.emit('permission-cancelled', { requestId: 'p6' });
  await new Promise(r => setImmediate(r));
  assert.equal(session.closed, false, 'Claude goes on');
  assert.equal(broker.getSnapshot().calls.length, 1);
  session.emit('permission', { requestId: 'p7', toolName: 'Bash', input: { command: 'npm run build' } });
  assert.equal(broker.getSnapshot().calls.length, 1, 'a later prompt still finds the conversation');
  session.busy = false;
  broker.setStreamBusy(call.id, false);
  assert.equal(broker.getSnapshot().calls[0].status, 'ringing');
});

// ── Review (alter ego) of 7fa4481 + aa2f17d ────────────────────────────────────────────────

const tick = () => new Promise(r => setImmediate(r));

test('asking and hanging up at once: Claude was about to start, so the call is kept (#1)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  ctl.say(call.id, 'Compila la web y llámame cuando acabes.', 'queue');
  broker.hangup(call.id); // before Claude's turn-start
  await tick();
  assert.equal(session.closed, false);
  assert.deepEqual(session.sent, ['Compila la web y llámame cuando acabes.']);
  assert.equal(broker.getSnapshot().calls[0].status, 'parked');
});

test('a correction and a hang-up: it rings for the corrected work, not for the interruption (#2)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  let release;
  session.sendUrgent = (text) => {
    session.sent.push(text);
    session.busy = false;
    session.emit('turn-end', { terminalReason: 'aborted', aborted: true }); // the interrupt lands first
    return new Promise(r => { release = () => { session.busy = true; r('u9'); }; });
  };
  session.busy = true;
  session.emit('turn-start');
  broker.hangup(call.id);
  ctl.say(call.id, 'No, mejor hazlo en otra rama.', 'interrupt');
  assert.equal(broker.getSnapshot().calls[0].status, 'parked', 'no ring while the correction is on its way');
  release();
  await tick();
  assert.equal(broker.getSnapshot().calls[0].status, 'parked');
  session.emit('turn-start');
  session.emit('assistant-message', { text: 'Hecho en una rama nueva.' });
  session.busy = false;
  session.emit('turn-end', { terminalReason: 'completed', aborted: false });
  assert.equal(broker.getSnapshot().calls[0].status, 'ringing');
});

test('two prompts at once are asked one after the other (#4)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.emit('permission', { requestId: 'a', toolName: 'WebFetch', input: { url: 'https://a.example' } });
  session.emit('permission', { requestId: 'b', toolName: 'WebFetch', input: { url: 'https://b.example' } });
  assert.equal(broker.getSnapshot().calls.length, 1);
  assert.equal(session.decisions.length, 0, 'the second does not cancel the first');
  broker.submitUserText(call.id, 'sí');
  await tick();
  assert.deepEqual(session.decisions.map(d => [d.requestId, d.allow]), [['a', true]]);
  assert.equal(broker.getSnapshot().calls[0].interactionKind, 'permission', 'now the second one');
  broker.submitUserText(call.id, 'no');
  assert.deepEqual(session.decisions.map(d => [d.requestId, d.allow]), [['a', true], ['b', false]]);
});

test('quitting kills a session that does not close in time (#5)', async () => {
  const { ctl, session } = setup();
  await ctl.start({ cwd: 'C:/work/app' });
  const killed = [];
  session.close = () => new Promise(() => {}); // never answers
  session.child = { pid: 4242, kill: () => killed.push('child') };
  session.killTree = (pid) => { killed.push(`tree ${pid}`); };
  await ctl.closeAll({ timeoutMs: 10 });
  assert.deepEqual(killed, ['tree 4242', 'child']);
});

test('picking up again mid-message: first what was missed, then Claude goes on live (#6)', async () => {
  const { broker, ctl, session, spoken, voice } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  session.emit('turn-start');
  session.emit('assistant-start', { messageId: 'm1' });
  broker.hold(call.id);
  session.emit('text', { delta: 'Ya he mirado el login. Ahora ' });
  assert.deepEqual(spoken, []);
  broker.answer(call.id);
  await tick();
  assert.equal(voice.turnStarts, 2, 'the stream turn starts again in the call');
  assert.deepEqual(spoken, ['Ya he mirado el login.']);
  session.emit('text', { delta: 'reviso la base de datos. ' });
  assert.deepEqual(spoken, ['Ya he mirado el login.', 'Ahora reviso la base de datos.']);
});

test('a session AgentCall drives never makes calls from its own hooks (#7)', async () => {
  const { broker, ctl, session } = setup();
  await ctl.start({ cwd: 'C:/work/app' });
  broker.setSessionMode(session.sessionId, 'on'); // e.g. /saul on in that conversation, earlier
  assert.equal(broker.sessionMode(session.sessionId, ''), 'off');
  assert.equal(broker.sessionMode(session.sessionId, 'on'), 'on', 'the controller\'s own prompts');
  await ctl.closeAll();
  assert.equal(broker.sessionMode(session.sessionId, ''), 'on', 'back to normal once AgentCall lets it go');
});

test('a controlled call that opens while the user is in another call waits on hold (#8)', async () => {
  const { broker, ctl } = setup();
  const other = broker.receivePermission({ session_id: 'x1', cwd: 'C:/api', tool_name: 'Bash', tool_input: { command: 'ls' } }, () => true, 'on');
  broker.answer(other.id);
  const call = await ctl.start({ cwd: 'C:/work/app' });
  assert.equal(broker.activeId, other.id);
  assert.equal(broker.getSnapshot().calls.find(c => c.id === call.id).status, 'onhold');
});

// ── Review round 2 ──────────────────────────────────────────────────────────────────────────

test('a callback with a question: what was missed goes before it, nothing cuts it (#1)', async () => {
  const { broker, ctl, session, spoken } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  session.emit('turn-start');
  broker.hangup(call.id);
  session.emit('assistant-start', { messageId: 'm1' });
  session.emit('text', { delta: 'Voy a borrar la carpeta vieja. ' });
  session.emit('assistant-message', { text: 'Voy a borrar la carpeta vieja.' });
  session.emit('permission', { requestId: 'p1', toolName: 'Bash', input: { command: 'rm -rf old' } });
  const pub = broker.getSnapshot().calls[0];
  assert.equal(pub.status, 'ringing');
  assert.match(pub.messages.at(-1).speech, /^Voy a borrar la carpeta vieja\. /);
  broker.answer(call.id);
  await tick();
  assert.deepEqual(spoken, [], 'no catch-up over the question');
  broker.submitUserText(call.id, 'sí');
  assert.equal(session.decisions[0].allow, true);
  session.emit('assistant-start', { messageId: 'm2' });
  session.emit('text', { delta: 'Hecho, la he borrado. Sigo. ' });
  assert.deepEqual(spoken, ['Hecho, la he borrado.', 'Sigo.']);
});

test('what the voice had not said when the user left is said on picking up (#4)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.turn(['Falla la cookie. ', 'Lo arreglo ahora.']);
  broker.hold(call.id);
  ctl.unheard(call.id, 'Lo arreglo ahora.');
  const last = broker.getSnapshot().calls[0].messages.at(-1);
  assert.equal(last.silent, false);
  assert.equal(last.speech, 'Lo arreglo ahora.');
  assert.equal(last.rev, 1, 'a new revision: the voice says it although it saw the message before');
});

test('unheard rest of a message still being written: caught up once, whole, never half twice (round 3 #4)', async () => {
  const { broker, ctl, session, spoken } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  session.emit('turn-start');
  session.emit('assistant-start', { messageId: 'm1' });
  session.emit('text', { delta: 'Uno. Dos. ' });
  broker.hold(call.id);
  ctl.unheard(call.id, 'Dos.');
  session.emit('text', { delta: 'Tres. ' });
  session.emit('assistant-message', { text: 'Uno. Dos. Tres.' });
  spoken.length = 0;
  broker.answer(call.id);
  await tick();
  assert.deepEqual(spoken, ['Uno. Dos. Tres.']);
});

test('a question cut by En espera is asked again whole on picking up (round 3 #1)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.emit('permission', { requestId: 'p1', toolName: 'Bash', input: { command: 'npm test' } });
  broker.hold(call.id);
  ctl.unheard(call.id, 'el resto de la pregunta');
  const asked = broker.getSnapshot().calls[0].messages.at(-1);
  assert.equal(asked.rev, 1);
  assert.notEqual(asked.speech, 'el resto de la pregunta', 'the whole question, not its tail');
});

test('"Terminar" ends a conversation from the list, even while Claude works (#5)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  broker.setStreamBusy(call.id, true);
  broker.hold(call.id);
  assert.equal(broker.dismiss(call.id), true);
  await tick();
  assert.equal(session.closed, true);
  assert.equal(broker.getSnapshot().calls.length, 0);
});

test('the card knows when Claude\'s session is gone (#5)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  broker.hold(call.id);
  session.emit('exit', { code: 1 });
  assert.equal(broker.getSnapshot().calls[0].sessionEnded, true);
});

test('hanging up with a prompt unanswered keeps it in Pendientes (Claude waits for it)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.emit('permission', { requestId: 'p9', toolName: 'Bash', input: { command: 'ls' } });
  broker.hangup(call.id);
  await new Promise(r => setImmediate(r));
  assert.equal(session.closed, false);
  assert.equal(session.decisions.length, 0);
  assert.equal(broker.getSnapshot().calls[0].status, 'pending');
});

test('if Claude exits, the call says so instead of going silent', async () => {
  const { broker, ctl, session } = setup();
  await ctl.start({ cwd: 'C:/work/app' });
  session.emit('exit', { code: 1 });
  const last = broker.getSnapshot().calls[0].messages.at(-1);
  assert.equal(last.role, 'assistant', 'said, not only shown');
  assert.match(last.text, /se ha cerrado/);
  assert.equal(ctl.say(broker.activeId, 'hola', 'queue').ok, false);
});

test('a permission Claude withdraws stops being asked in the call', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.emit('permission', { requestId: 'p5', toolName: 'Bash', input: { command: 'npm test' } });
  assert.equal(broker.getSnapshot().calls[0].waiting, true);
  session.emit('permission-cancelled', { requestId: 'p5' });
  const pub = broker.getSnapshot().calls.find(c => c.id === call.id);
  assert.equal(pub.interactionKind === 'permission' && pub.waiting, false);
});

// ── Full-day review (2026-11-03) ─────────────────────────────────────────────

test('a message queued during a turn continues the same voice utterance (review A3)', async () => {
  const { ctl, session, spoken } = setup();
  await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  session.emit('turn-start');
  session.emit('text', { delta: 'Google funciona. ' });
  session.emit('assistant-message', { text: 'Google funciona.' });
  session.emit('turn-end', { terminalReason: 'completed', aborted: false }); // busy: "y también Apple" is queued
  session.emit('turn-start');
  session.emit('text', { delta: 'Apple también. ' });
  session.emit('assistant-message', { text: 'Apple también.' });
  session.busy = false;
  session.emit('turn-end', { terminalReason: 'completed', aborted: false });
  assert.deepEqual(spoken, ['Google funciona.', 'Apple también.', '<end>'], 'no end (and no cut) between the turns');
});

test('picking up mid-message: the sentences the user left unheard come first (review A4)', async () => {
  const { broker, ctl, session, spoken } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  session.emit('turn-start');
  session.emit('assistant-start', { messageId: 'm1' });
  session.emit('text', { delta: 'Uno es esto. Dos es aquello. ' });
  broker.hold(call.id);
  ctl.unheard(call.id, 'Dos es aquello.');
  session.emit('text', { delta: 'Tres va después. ' });
  spoken.length = 0;
  broker.answer(call.id);
  await tick();
  assert.deepEqual(spoken, ['Dos es aquello.', 'Tres va después.']);
});

test('a turn that ends in an error is said, not silent (review A5)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  session.emit('turn-start');
  session.busy = false;
  session.emit('turn-end', { terminalReason: 'completed', aborted: false, isError: true, result: 'API Error: 529 overloaded' });
  const last = broker.calls.get(call.id).messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.silent, undefined);
  assert.match(last.text, /error: API Error: 529/);
  assert.match(last.speech, /error/);
});

test('an answer that is all list or code is never silent (review A10)', async () => {
  const { ctl, session, spoken } = setup();
  await ctl.start({ cwd: 'C:/work/app' });
  const silent = () => ({ push: () => [], finish: () => '' }); // what SpeechChunker gives for a list
  ctl.createChunker = silent;
  session.busy = true;
  session.emit('turn-start');
  session.emit('assistant-start', { messageId: 'm1' });
  session.emit('text', { delta: '```js\nconst a = 1;\n```' });
  session.emit('assistant-message', { text: '```js\nconst a = 1;\n```' });
  session.busy = false;
  session.emit('turn-end', { terminalReason: 'completed', aborted: false });
  assert.deepEqual(spoken, ['Te lo he dejado escrito en pantalla.', '<end>']);
});

test('calling a conversation that is already open goes back to it, no second process (review A6)', async () => {
  const { broker, session } = setup();
  let created = 0;
  const ctl2 = new StreamCallController({ broker, voice: { streamTurnStart() {}, streamMessageStart() {}, streamSentence() {}, streamTurnEnd() {} }, createChunker: chunker, createSession: () => { created += 1; return session; } });
  const call = await ctl2.start({ cwd: 'C:/work/app' });
  broker.hold(call.id);
  const again = await ctl2.start({ cwd: 'C:/work/app', resume: session.sessionId });
  assert.equal(again.id, call.id);
  assert.equal(created, 1);
  assert.equal(broker.activeId, call.id);
});

test('a permission after "Terminar" is denied, never a call nobody can answer (review A7)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  let release;
  session.close = () => new Promise(r => { release = r; }); // closing takes a while
  session.busy = true;
  broker.setStreamBusy(call.id, true);
  broker.hold(call.id);
  broker.dismiss(call.id);
  session.emit('permission', { requestId: 'p1', toolName: 'Bash', input: { command: 'git push' } });
  assert.equal(broker.getSnapshot().calls.length, 0, 'no ghost call');
  assert.deepEqual(session.decisions.map(d => [d.requestId, d.allow]), [['p1', false]]);
  assert.equal(broker.sessionMode(session.sessionId, ''), 'off', 'its own hooks stay off while it closes');
  assert.equal(ctl.busy(), true, 'quitting waits for it');
  await tick();
  release();
  await tick();
  assert.equal(ctl.busy(), false);
});

test('a withdrawn prompt is cancelled in the call that holds it (review A7)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.emit('permission', { requestId: 'p1', toolName: 'Bash', input: { command: 'ls' } });
  const holder = broker.calls.get(call.id);
  assert.equal(holder.interactionKind, 'permission');
  session.emit('permission-cancelled', { requestId: 'p1' });
  assert.notEqual(broker.calls.get(call.id).interactionKind, 'permission');
  assert.deepEqual(session.decisions, [], 'a request Claude withdrew is not answered');
});

test('a call hung up while idle calls back if Claude starts working on its own (review B6)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  broker.hangup(call.id);
  assert.equal(broker.calls.get(call.id).status, 'ended');
  session.busy = true;
  session.emit('turn-start');
  assert.equal(broker.calls.get(call.id).status, 'parked');
  session.emit('text', { delta: 'He terminado la tarea. ' });
  session.emit('assistant-message', { text: 'He terminado la tarea.' });
  session.busy = false;
  session.emit('turn-end', { terminalReason: 'completed', aborted: false });
  assert.equal(broker.calls.get(call.id).status, 'ringing');
});

test('a prompt withdrawn while the user is on the line leaves Claude working, not "ready" (review B8)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.busy = true;
  broker.setStreamBusy(call.id, true);
  session.emit('permission', { requestId: 'p1', toolName: 'Bash', input: { command: 'ls' } });
  session.emit('permission-cancelled', { requestId: 'p1' });
  const c = broker.calls.get(call.id);
  assert.equal(c.awaitingClaude, true);
  assert.equal(c.interactionKind, null);
  assert.ok(!c.messages.some(m => /terminal/.test(m.text || '')));
});

test('a heading and a list caught up on later say they are on screen (round 2 #11)', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  ctl.createChunker = () => ({ push: () => [], finish: () => '' }); // what SpeechChunker gives for it
  broker.hold(call.id);
  session.busy = true;
  session.emit('turn-start');
  session.emit('assistant-start', { messageId: 'm1' });
  session.emit('text', { delta: '## Resumen\n\n- Uno\n- Dos' });
  session.emit('assistant-message', { text: '## Resumen\n\n- Uno\n- Dos' });
  session.busy = false;
  session.emit('turn-end', { terminalReason: 'completed', aborted: false });
  const last = broker.calls.get(call.id).messages.at(-1);
  assert.equal(last.speech, 'Te lo he dejado escrito en pantalla.');
});
