// Voice First §26 acceptance conversation, end to end through VoiceConversation + CallBroker with a
// fake clock and simulated hooks (hook mode). It checks what reaches Claude, in which order, when
// Claude's voice is cut, that a thinking pause does not cut the user and that nothing said is lost.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CallBroker } = require('../src/broker');
const { VoiceConversation } = require('../src/voice/conversation');
const { AdaptiveEndpointer } = require('../src/voice/endpointing');

function world() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { at: now + ms, fn }); return seq; },
    clearTimer: id => timers.delete(id),
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    now = end;
  };

  const broker = new CallBroker({ defaultMode: 'on', now: clock.now, minResultMs: 0 });
  const conv = new VoiceConversation({
    ...clock,
    policy: kind => new AdaptiveEndpointer({ kind }),
    deliver: ({ callId, sessionId, text, urgency }) => { // same routing as main.js routeUserText
      const call = broker.calls.get(callId);
      if (!call) return { ...broker.queueSessionSpeech(sessionId, text, urgency), route: 'steer' };
      const answering = Boolean(call.responder && !call.resolved);
      const result = answering ? broker.submitUserText(callId, text) : broker.queueUserSpeech(callId, text, urgency);
      return { ...result, route: answering ? 'answer' : 'steer' };
    },
  });
  broker.on('change', snapshot => conv.setCall(snapshot.calls.find(c => c.id === snapshot.activeId) || null));

  const log = [];     // what Claude received, in order
  const spoken = [];  // what Claude said aloud
  const stops = [];   // when Claude's voice was cut
  conv.on('speak', ({ id, text }) => {
    spoken.push(text);
    conv.tts({ type: 'chunk', id, seq: 0, text: text.split('. ')[0] }); // the first sentence starts playing
  });
  conv.on('tts', ({ action }) => { if (action === 'stop') stops.push(now); });

  // Claude ends a turn (Stop hook held until the user answers).
  const claudeStops = (message) => broker.receiveCompletion(
    { session_id: 'auth', cwd: 'C:/work/app', stop_hook_active: true, last_assistant_message: message },
    { responder: body => { log.push(['Stop', body.hookSpecificOutput?.additionalContext || '(fin)']); return true; } },
  );
  const toolRuns = () => {
    const out = broker.noteToolDone({ session_id: 'auth', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    if (out) log.push(['PostToolUse', out.hookSpecificOutput.additionalContext]);
  };
  const finishSpeaking = () => { const cur = conv.playing; if (cur) conv.tts({ type: 'end', id: cur.id }); };

  // The user says one phrase: VAD start, partials, VAD end after 0.7 s of silence, final 0.6 s later.
  const say = (text, { ms = 1200 } = {}) => {
    conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
    advance(400);
    conv.stt({ type: 'partial', text });
    advance(ms - 400 + 700);
    conv.stt({ type: 'speech', state: 'end', silence_ms: 700 });
    advance(600);
    conv.stt({ type: 'final', text, confidence: 0.9 });
  };
  return { broker, conv, advance, say, claudeStops, toolRuns, finishSpeaking, log, spoken, stops, now: () => now };
}

test('§26: the acceptance conversation works without the user adapting how they speak', () => {
  const w = world();

  // Claude calls. Alejandro answers.
  const call = w.claudeStops('He terminado el cambio de autenticación, pero antes de seguir necesito decidir cómo vamos a guardar las sesiones.');
  assert.equal(call.status, 'ringing');
  w.broker.answer(call.id);
  assert.match(w.spoken[0], /He terminado el cambio de autenticación/);

  // Alejandro interrupts while Claude is still speaking.
  w.say('Espera, espera. Antes de eso, ¿has comprobado que no rompe Google?');
  assert.equal(w.stops.length, 1, 'Claude stops speaking');
  w.advance(1500);
  assert.equal(w.log.length, 1);
  assert.match(w.log[0][1], /Antes de eso, ¿has comprobado que no rompe Google\?/);

  // Claude answers; same call.
  const merged = w.claudeStops('No. He probado email y contraseña, pero todavía no Google.');
  assert.equal(merged.id, call.id, 'one call for the whole conversation');
  assert.match(w.spoken.at(-1), /todavía no Google/);
  w.finishSpeaking();

  // "Vale pues prueba Google y… un momento…" — two-second thinking pause — "y si falla…".
  w.say('Vale pues prueba Google y...');
  w.advance(400);
  w.say('un momento...', { ms: 700 });
  w.advance(2000);
  assert.equal(w.log.length, 1, 'the thinking pause does not cut him off');
  w.say('y si falla no lo arregles todavía, dime primero qué ha roto.');
  w.advance(1500);
  assert.equal(w.log.length, 2);
  assert.match(w.log[1][1], /prueba Google y\.\.\. un momento\.\.\. y si falla no lo arregles todavía, dime primero qué ha roto/);

  // Claude works. Three seconds later Alejandro corrects himself; it is delivered at the next tool call.
  w.advance(3000);
  w.say('Ah, y me he equivocado antes: prueba también Apple.');
  w.advance(1500);
  assert.equal(w.log.length, 2, 'not lost, waiting for a safe point');
  w.toolRuns();
  assert.equal(w.log[2][0], 'PostToolUse');
  assert.match(w.log[2][1], /interrumpido/);
  assert.match(w.log[2][1], /prueba también Apple/);

  // Claude reports; Alejandro cuts the explanation short with a question.
  w.claudeStops('Google funciona. Apple falla porque la clave del servicio no coincide con el identificador de la app y además…');
  const stopsBefore = w.stops.length;
  w.say('No, no hace falta que me expliques todo. ¿Es nuestro código o la configuración?');
  assert.equal(w.stops.length, stopsBefore + 1, 'Claude stops at once');
  w.advance(1500);
  assert.match(w.log.at(-1)[1], /¿Es nuestro código o la configuración\?/);

  w.claudeStops('La configuración.');
  w.finishSpeaking();
  w.say('Pues arréglala.');
  w.advance(1500);
  assert.match(w.log.at(-1)[1], /Pues arréglala/);

  w.claudeStops('Ya funcionan Google y Apple. Las pruebas pasan.');
  w.finishSpeaking();
  w.say('Perfecto, pues listo.');
  w.broker.hangup(call.id); // hangs up right away
  assert.equal(w.log.at(-1)[1], '(fin)', 'hanging up a result means done: Claude stops, it does not call back');
  assert.equal(w.broker.getSnapshot().calls.length, 0);
  // …and his last words are not lost: they travel with the next prompt or hook of that session.
  assert.deepEqual(w.broker.pendingSpeech('auth').map(i => i.text), ['Perfecto, pues listo.']);

  // Everything Alejandro said reached Claude, in order, through one call.
  const said = w.log.map(([, text]) => text).join('\n');
  for (const phrase of ['no rompe Google', 'dime primero qué ha roto', 'prueba también Apple', 'nuestro código o la configuración', 'Pues arréglala']) {
    assert.ok(said.includes(phrase), phrase);
  }
  assert.ok(said.indexOf('no rompe Google') < said.indexOf('prueba también Apple'));
});
