const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CallBroker } = require('../src/broker');
const { StreamCallController } = require('../src/voice/stream-call');

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
    streamTurnStart() { this.turnStarts += 1; },
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

test('hanging up closes the session and denies anything still pending', async () => {
  const { broker, ctl, session } = setup();
  const call = await ctl.start({ cwd: 'C:/work/app' });
  session.emit('permission', { requestId: 'p9', toolName: 'Bash', input: { command: 'ls' } });
  broker.hangup(call.id);
  await new Promise(r => setImmediate(r));
  assert.equal(session.closed, true);
  assert.equal(session.decisions.at(-1).allow, false);
  assert.equal(ctl.owns(call.id), false);
});

test('if Claude exits, the call says so instead of going silent', async () => {
  const { broker, ctl, session } = setup();
  await ctl.start({ cwd: 'C:/work/app' });
  session.emit('exit', { code: 1 });
  const last = broker.getSnapshot().calls[0].messages.at(-1);
  assert.equal(last.role, 'system');
  assert.match(last.text, /se ha cerrado/);
  assert.equal(ctl.say(broker.activeId, 'hola', 'queue').ok, false);
});
