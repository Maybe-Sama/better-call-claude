const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceConversation, classifyUrgency, HOLD_MS, BARGE_CONFIRM_MS } = require('../src/voice/conversation');

// Fake clock + timers; `out` collects every event the conversation emits.
function harness(options = {}) {
  let now = 1000;
  let seq = 0;
  const timers = new Map();
  const conv = new VoiceConversation({
    now: () => now,
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { at: now + ms, fn }); return seq; },
    clearTimer: id => timers.delete(id),
    ...options,
  });
  const out = [];
  for (const name of ['commit', 'speak', 'tts', 'ack', 'local', 'metric']) conv.on(name, data => out.push({ ev: name, ...data }));
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
  // The user says `text`: VAD start, `ms` of speech, VAD end after 700 ms of silence, final 500 ms later.
  const say = (text, { ms = 900, confidence = 0.9, partial = null } = {}) => {
    conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
    advance(Math.min(600, ms));
    if (partial) conv.stt({ type: 'partial', text: partial });
    advance(Math.max(0, ms - 600) + 700);
    conv.stt({ type: 'speech', state: 'end', silence_ms: 700 });
    advance(500);
    conv.stt({ type: 'final', text, confidence });
  };
  const events = name => out.filter(o => o.ev === name);
  return { conv, out, advance, say, events };
}

const assistant = (text, at = 1) => ({ role: 'assistant', text, speech: text, at });
const waitingCall = (over = {}) => ({ id: 'c1', sessionId: 's1', interactionKind: 'stop', waiting: true, awaitingClaude: false, messages: [assistant('He terminado el cambio.')], ...over });
const workingCall = (over = {}) => ({ id: 'c1', sessionId: 's1', interactionKind: null, waiting: false, awaitingClaude: true, messages: [assistant('He terminado el cambio.'), { role: 'user', text: 'Vale', at: 2 }], ...over });

test('speaks each new assistant message once', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.conv.setCall(waitingCall());
  assert.equal(h.events('speak').length, 1);
  assert.equal(h.events('speak')[0].text, 'He terminado el cambio.');
  h.conv.setCall(waitingCall({ messages: [assistant('He terminado el cambio.'), assistant('¿Lo subo?', 5)] }));
  assert.deepEqual(h.events('speak').map(s => s.text), ['He terminado el cambio.', '¿Lo subo?']);
});

test('answers a waiting call once the user has finished', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.say('Haz el cambio en la base de datos.');
  assert.equal(h.events('commit').length, 0, 'not while the user may still be talking');
  h.advance(5000);
  const [commit] = h.events('commit');
  assert.equal(commit.route, 'answer');
  assert.equal(commit.text, 'Haz el cambio en la base de datos.');
  assert.equal(commit.callId, 'c1');
});

test('keeps listening while Claude works and queues what the user adds', () => {
  const h = harness();
  h.conv.setCall(workingCall());
  assert.equal(h.conv.listening(), true);
  h.say('Ah, y no toques el login de Google.');
  h.advance(6000);
  const [commit] = h.events('commit');
  assert.equal(commit.route, 'steer');
  assert.equal(commit.urgency, 'queue');
});

test('a correction while Claude works is an interrupt', () => {
  const h = harness();
  h.conv.setCall(workingCall());
  h.say('No, me he explicado mal.');
  h.advance(6000);
  assert.equal(h.events('commit')[0].urgency, 'interrupt');
});

test('classifyUrgency: corrections interrupt, additions queue', () => {
  for (const text of ['Para.', 'Espera, no hagas eso.', 'No, no, eso no.', 'Me he equivocado: verde.', 'Antes de seguir, revisa el login.', 'Corrijo, quería decir la segunda.']) {
    assert.equal(classifyUrgency(text), 'interrupt', text);
  }
  for (const text of ['Y cuando termines haz también el test.', 'Ah, y otra cosa: usa Supabase.', 'Vale, sigue.']) {
    assert.equal(classifyUrgency(text), 'queue', text);
  }
});

test('"Espera" alone holds the turn and joins what comes next', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.say('Espera.');
  h.advance(12000);
  assert.equal(h.events('commit').length, 0, 'a lone "espera" is not an answer');
  h.say('Antes de eso, ¿has comprobado que no rompe Google?');
  h.advance(5000);
  const [commit] = h.events('commit');
  assert.equal(commit.text, 'Espera. Antes de eso, ¿has comprobado que no rompe Google?');
});

test('while Claude works, a lone "espera" becomes an interrupt after the hold', () => {
  const h = harness();
  h.conv.setCall(workingCall());
  h.say('Espera, espera.');
  h.advance(3000);
  assert.equal(h.events('commit').length, 0);
  h.advance(HOLD_MS);
  const [commit] = h.events('commit');
  assert.equal(commit.urgency, 'interrupt');
  assert.equal(commit.text, 'Espera, espera.');
});

test('barge-in: the user talking over Claude stops the voice, Claude\'s own echo does not', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'He terminado el cambio.' });
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.conv.stt({ type: 'partial', text: 'terminado el cambio' });
  assert.equal(h.events('tts').length, 0, 'echo of Claude through the speakers');
  h.conv.stt({ type: 'partial', text: 'espera por qué no SQLite' });
  assert.deepEqual(h.events('tts').map(t => t.action), ['stop']);
  assert.ok(h.events('metric').some(m => m.name === 'bargein.stop_ms'));
});

test('"sigue" resumes the interrupted sentence instead of going to Claude', () => {
  const h = harness();
  const text = 'Hay dos formas de hacerlo. La primera mantiene la tabla actual. La segunda la reemplaza.';
  h.conv.setCall(waitingCall({ messages: [assistant(text)] }));
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Hay dos formas de hacerlo.' });
  h.conv.tts({ type: 'chunk', id, seq: 1, text: 'La primera mantiene la tabla actual.' });
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.conv.stt({ type: 'partial', text: 'espera un segundo' });
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.say('Sigue.');
  h.advance(5000);
  assert.equal(h.events('commit').length, 0);
  assert.equal(h.events('speak').at(-1).text, 'La primera mantiene la tabla actual. La segunda la reemplaza.');
});

test('"repíteme lo último" repeats the sentence that was cut', () => {
  const h = harness();
  h.conv.setCall(waitingCall({ messages: [assistant('Primera frase. Segunda frase importante. Tercera.')] }));
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Primera frase.' });
  h.conv.tts({ type: 'chunk', id, seq: 1, text: 'Segunda frase importante.' });
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.conv.stt({ type: 'partial', text: 'perdona no te oigo' });
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.say('Repíteme lo último.');
  h.advance(5000);
  assert.equal(h.events('commit').length, 0);
  assert.equal(h.events('speak').at(-1).text, 'Segunda frase importante. Tercera.');
});

test('acknowledgements fit what happened', () => {
  const h = harness();
  h.conv.setCall(waitingCall({ interactionKind: 'permission' }));
  h.conv.committed({ ok: true, route: 'answer', text: 'Sí.', decision: 'allow' });
  assert.deepEqual(h.events('ack').map(a => a.phrase), ['vale']);
  h.conv.committed({ ok: true, route: 'steer', urgency: 'interrupt', text: 'Para.' });
  assert.equal(h.events('ack').length, 1, 'no "vale" after "para"');
  h.conv.committed({ ok: true, route: 'answer', text: '¿Por qué esa opción?', clarification: true });
  assert.deepEqual(h.events('ack').map(a => a.phrase), ['vale', 'momento']);
});

test('muted: nothing the microphone hears is used', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.conv.setMuted(true);
  assert.equal(h.conv.listening(), false);
  h.say('Haz el cambio.');
  h.advance(6000);
  assert.equal(h.events('commit').length, 0);
});

test('typing takes over the spoken draft', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.say('Cambia el endpoint de Supabase');
  assert.equal(h.conv.adoptDraft(), 'Cambia el endpoint de Supabase');
  h.advance(6000);
  assert.equal(h.events('commit').length, 0, 'the user will send it with Enter');
});

test('words still waiting when the call ends go to that call, not to the next one', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.say('Haz el cambio');
  h.conv.setCall(waitingCall({ id: 'c2', sessionId: 's2' }));
  h.advance(6000);
  assert.deepEqual(h.events('commit').map(c => [c.callId, c.sessionId, c.text]), [['c1', 's1', 'Haz el cambio']]);
});

test('muting during the countdown sends what was already said', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.say('Usa Supabase');
  h.conv.setMuted(true);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Usa Supabase']);
});

test('a low-confidence recognition is not sent', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.say('Orlando', { confidence: 0.11 });
  h.advance(6000);
  assert.equal(h.events('commit').length, 0);
  assert.equal(h.conv.snapshot().lowConfidence, true);
});

test('a turn deferred while Claude speaks is not sent if the user goes on talking', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.conv.tts({ type: 'end', id: h.events('speak')[0].id });
  h.say('Haz el cambio');
  h.conv._speak('Un aviso de Claude.'); // defensive path: Claude talking when the deadline comes
  const { id } = h.events('speak').at(-1);
  h.advance(5000);
  assert.equal(h.events('commit').length, 0, 'never answered while Claude talks');
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.conv.tts({ type: 'end', id });
  assert.equal(h.events('commit').length, 0, 'not mid-sentence');
  h.advance(700);
  h.conv.stt({ type: 'speech', state: 'end', silence_ms: 700 });
  h.advance(400);
  h.conv.stt({ type: 'final', text: 'en la base de datos.', confidence: 0.9 });
  h.advance(5000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Haz el cambio en la base de datos.']);
});

test('a failed delivery gives the spoken words back instead of losing them', () => {
  const h = harness({ deliver: () => ({ ok: false, error: 'La llamada ya no existe.' }) });
  const appended = [];
  const errors = [];
  h.conv.on('append', a => appended.push(a.text));
  h.conv.on('error', e => errors.push(e.message));
  h.conv.setCall(waitingCall());
  h.say('Haz el cambio.');
  h.advance(5000);
  assert.deepEqual(appended, ['Haz el cambio.']);
  assert.deepEqual(errors, ['La llamada ya no existe.']);
  assert.equal(h.events('ack').length, 0);
});

test('an asynchronous delivery acknowledges once it resolves', async () => {
  const h = harness({ deliver: () => Promise.resolve({ ok: true, route: 'answer' }) });
  h.conv.setCall(waitingCall());
  h.say('Haz el cambio.');
  h.advance(5000);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(h.events('ack').map(a => a.phrase), ['vale']);
});

test('leaving the call silences Claude and forgets its echo', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.conv.setCall(null);
  assert.deepEqual(h.events('tts').map(t => t.action), ['stop']);
  assert.equal(h.conv.snapshot().turn, 'idle');
});

test('measures how long the voice takes to go silent after a stop', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'He terminado el cambio.' });
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.conv.stt({ type: 'partial', text: 'espera por qué no SQLite' });
  h.advance(40);
  h.conv.tts({ type: 'end', id, interrupted: true });
  assert.deepEqual(h.events('metric').filter(m => m.name === 'tts.stop_ms').map(m => m.ms), [40]);
});

test('typed text sent while a spoken draft is pending keeps both', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.say('Usa Supabase');
  h.conv.submitTyped('y el plan gratuito.');
  assert.deepEqual(h.events('commit').map(c => c.text), ['Usa Supabase y el plan gratuito.']);
});

// ── Barge-in with echo cancellation (capture "aec"): act on the voice detector, not on words ─────

function speakingCall(h) {
  h.conv.setEchoCancelled(true);
  h.conv.setCall(waitingCall());
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'He terminado el cambio.' });
  return id;
}

test('aec: the voice ducks at once and stops if the user keeps talking', () => {
  const h = harness();
  speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck'], 'no waiting for Whisper');
  h.advance(BARGE_CONFIRM_MS);
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck', 'stop']);
  const duck = h.events('metric').find(m => m.name === 'bargein.duck_ms');
  assert.equal(duck.ms, 90, 'from the onset of the voice');
});

test('aec: a cough only ducks for a moment', () => {
  const h = harness();
  speakingCall(h);
  const failures = [];
  h.conv.on('failure', f => failures.push(f));
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.advance(120);
  h.conv.stt({ type: 'speech', state: 'end', silence_ms: 60 });
  h.advance(1000);
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck', 'unduck']);
  assert.equal(h.conv.speaking(), true, 'Claude goes on');
  assert.deepEqual(failures, ['false_speech_start']);
});

test('aec: words while ducked stop Claude before the confirmation time', () => {
  const h = harness();
  speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.advance(100);
  h.conv.stt({ type: 'partial', text: 'espera' });
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck', 'stop']);
});

test('without aec, the voice detector alone never stops Claude (it may be its own echo)', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.advance(1000);
  assert.equal(h.events('tts').length, 0);
});

test('an answer that repeats Claude\'s words after Claude went quiet is the user, not echo', () => {
  const h = harness();
  h.conv.setCall(waitingCall({ messages: [assistant('¿Prefieres Supabase o Neon?')] }));
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: '¿Prefieres Supabase o Neon?' });
  h.advance(2000);
  h.conv.tts({ type: 'end', id });
  h.advance(400);
  h.say('Neon.');
  h.advance(3000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Neon.']);
});

test('without echo cancellation, Claude\'s own words heard while it speaks are still echo', () => {
  const h = harness();
  h.conv.setCall(waitingCall({ messages: [assistant('¿Prefieres Supabase o Neon?')] }));
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: '¿Prefieres Supabase o Neon?' });
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 }); // the speakers, during playback
  h.advance(900);
  h.conv.tts({ type: 'end', id });
  h.advance(700);
  h.conv.stt({ type: 'speech', state: 'end', silence_ms: 700 });
  h.advance(500);
  h.conv.stt({ type: 'final', text: 'Supabase o Neon', confidence: 0.8 });
  h.advance(4000);
  assert.equal(h.events('commit').length, 0);
});

test('with echo cancellation nothing is discarded as echo', () => {
  const h = harness();
  h.conv.setEchoCancelled(true);
  h.conv.setCall(waitingCall({ messages: [assistant('¿Prefieres Supabase o Neon?')] }));
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: '¿Prefieres Supabase o Neon?' });
  h.say('Supabase o Neon, no sé.');
  h.advance(4000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Supabase o Neon, no sé.']);
});

test('a stale result marked silent is shown but not read aloud', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [assistant('He terminado.'), { role: 'assistant', text: 'Ya está.', speech: '', silent: true, at: 9 }] }));
  assert.deepEqual(h.events('speak').map(s => s.text), []);
});

test('a phrase transcribed while typing goes to the box and does not leave the turn waiting', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.conv.setTyping(true);
  const appended = [];
  h.conv.on('append', a => appended.push(a.text));
  h.say('y el plan gratuito');
  h.conv.setTyping(false);
  h.say('Haz el cambio.');
  h.advance(1500);
  assert.deepEqual(appended, ['y el plan gratuito']);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Haz el cambio.']);
});
