'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CallBroker, parsePermission, matchQuestionAnswer } = require('../src/broker');

function askPayload(session = 's1') {
  return {
    session_id: session,
    cwd: 'C:/work/eureka',
    tool_input: {
      questions: [{
        question: '¿Qué opción prefieres?',
        header: 'Arquitectura',
        options: [{ label: 'A', description: 'simple' }, { label: 'B', description: 'robusta' }],
        multiSelect: false,
      }],
    },
  };
}

test('AskUserQuestion rings, answers through updatedInput and waits for Claude', () => {
  const broker = new CallBroker({ ringTimeoutMs: 1000 });
  let response;
  const call = broker.receiveAskUser(askPayload(), body => { response = body; });
  assert.equal(call.status, 'ringing');
  assert.equal(broker.answer(call.id), true);
  const result = broker.submitUserText(call.id, 'la segunda');
  assert.equal(result.resolved, true);
  assert.equal(response.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(response.hookSpecificOutput.updatedInput.answers['¿Qué opción prefieres?'], 'B');
  assert.equal(broker.getSnapshot().calls[0].awaitingClaude, true);
});

test('natural clarification on AskUserQuestion is fed back to Claude instead of forced into an option', () => {
  const broker = new CallBroker({ ringTimeoutMs: 1000 });
  let response;
  const call = broker.receiveAskUser(askPayload('clarify'), body => { response = body; });
  broker.answer(call.id);
  const result = broker.submitUserText(call.id, '¿Por qué no recomiendas la opción A?');
  assert.equal(result.clarification, true);
  assert.equal(response.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(response.hookSpecificOutput.permissionDecisionReason, /Por qué no recomiendas/);
});

test('choice matcher understands ordinals and labels', () => {
  const q = askPayload().tool_input.questions[0];
  assert.equal(matchQuestionAnswer(q, 'la segunda'), 'B');
  assert.equal(matchQuestionAnswer(q, 'A'), 'A');
  assert.equal(matchQuestionAnswer(q, 'quiero B'), 'B');
});

test('final Stop call can receive a spoken follow-up and continue Claude', () => {
  const broker = new CallBroker({ ringTimeoutMs: 1000 });
  let response;
  const call = broker.receiveCompletion({ session_id: 's2', cwd: 'C:/work/web', last_assistant_message: 'La página está terminada.' }, { responder: body => { response = body; } });
  broker.answer(call.id);
  const result = broker.submitUserText(call.id, 'Ábreme la web para verla');
  assert.equal(result.continued, true);
  assert.match(response.hookSpecificOutput.additionalContext, /Ábreme la web/);
});

test('hanging up a completion call means done and lets Stop finish', () => {
  const broker = new CallBroker({ ringTimeoutMs: 1000 });
  let response = null;
  const call = broker.receiveCompletion({ session_id: 's3', last_assistant_message: 'He terminado.' }, { responder: body => { response = body; } });
  broker.answer(call.id);
  broker.hangup(call.id);
  assert.deepEqual(response, {});
  assert.equal(broker.getSnapshot().calls.length, 0);
});

test('a second session is queued while another call is active', () => {
  const broker = new CallBroker({ ringTimeoutMs: 1000 });
  const first = broker.receiveAskUser(askPayload('s1'), () => {});
  broker.answer(first.id);
  const second = broker.receiveAskUser(askPayload('s2'), () => {});
  assert.equal(second.status, 'queued');
  assert.equal(broker.getSnapshot().counts.queued, 1);
});

test('DND routes new calls to pending silently', () => {
  const broker = new CallBroker({ ringTimeoutMs: 1000 });
  broker.setDnd(true);
  const call = broker.receiveAskUser(askPayload('s4'), () => {});
  assert.equal(call.status, 'pending');
});

test('ring timeout moves call to pending', async () => {
  const broker = new CallBroker({ ringTimeoutMs: 20 });
  const call = broker.receiveAskUser(askPayload('s5'), () => {});
  assert.equal(call.status, 'ringing');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(broker.getSnapshot().calls.find(c => c.id === call.id).status, 'pending');
});

test('permission parser accepts natural Spanish yes/no', () => {
  assert.equal(parsePermission('Sí, adelante'), 'allow');
  assert.equal(parsePermission('vale, hazlo'), 'allow');
  assert.equal(parsePermission('No, no lo hagas'), 'deny');
  assert.equal(parsePermission('depende'), null);
});
