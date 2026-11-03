const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceConversation, classifyUrgency, HOLD_MS, BARGE_CONFIRM_MS, DUCK_AFTER_MS, VAD_TAIL_MS } = require('../src/voice/conversation');
// A voice still going this long after it began has really lasted BARGE_CONFIRM_MS (Whisper ends a phrase late).
const SUSTAINED_MS = BARGE_CONFIRM_MS + VAD_TAIL_MS;

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
  h.conv.tts({ type: 'end', id: h.events('speak')[0].id }); // (a new message never cuts one being said)
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
  h.advance(HOLD_MS + 5000); // the end-of-turn wait for "espera" (4.5 s) plus the hold
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

test('aec: sustained voice lowers Claude, and stops it if it goes on', () => {
  const h = harness();
  speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  assert.deepEqual(h.events('tts').map(t => t.action), [], 'a sound alone changes nothing yet');
  h.advance(DUCK_AFTER_MS);
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck'], 'no waiting for Whisper');
  h.advance(BARGE_CONFIRM_MS - DUCK_AFTER_MS);
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck'], 'the end of a phrase is reported 0.7 s late: not yet');
  h.advance(VAD_TAIL_MS);
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck', 'stop']);
  const duck = h.events('metric').find(m => m.name === 'bargein.duck_ms');
  assert.equal(duck.ms, DUCK_AFTER_MS + 90, 'from the onset of the voice');
});

// Live test 2026-11-02 (headphones, AEC): murmurs, breathing and "ajá" cut Claude 20 times in four
// minutes and every resume started the sentence again.
test('aec: short sounds while Claude talks never cut or restart it', () => {
  const h = harness();
  const id = speakingCall(h);
  for (let i = 0; i < 20; i += 1) {
    h.conv.stt({ type: 'speech', state: 'start', utterance: i, onset_ms: 90 });
    h.advance(i % 2 ? 200 : DUCK_AFTER_MS + 300);
    h.conv.stt({ type: 'speech', state: 'end', utterance: i, silence_ms: 700, voiced_ms: 400 });
    h.advance(300);
    h.conv.stt({ type: 'rejected', utterance: i });
    h.advance(2000);
  }
  assert.ok(!h.events('tts').some(t => t.action === 'stop'));
  assert.equal(h.events('speak').length, 1, 'never started again');
  assert.equal(h.conv.playing.id, id);
});

test('a stop names the utterance it stops (a late stop must not cut the next answer)', () => {
  const h = harness();
  const id = speakingCall(h);
  h.conv.setCall(null); // hung up: what was playing is stopped
  const stop = h.events('tts').find(t => t.action === 'stop');
  assert.equal(stop.id, id);
});

test('aec: a longer noise only lowers Claude for a moment', () => {
  const h = harness();
  speakingCall(h);
  const failures = [];
  h.conv.on('failure', f => failures.push(f));
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.advance(DUCK_AFTER_MS + 200);
  h.conv.stt({ type: 'speech', state: 'end', silence_ms: 60 });
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck'], 'low until its transcript says what it was');
  h.advance(400);
  h.conv.stt({ type: 'rejected' });
  h.advance(1000);
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck', 'unduck']);
  assert.equal(h.conv.speaking(), true, 'Claude goes on');
  assert.deepEqual(failures, ['false_speech_start']);
});

test('aec: words while ducked stop Claude before the confirmation time', () => {
  const h = harness();
  speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.advance(DUCK_AFTER_MS + 100);
  h.conv.stt({ type: 'partial', text: 'espera' });
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck', 'stop']);
});

test('aec: a short "para" keeps Claude low and its transcript stops it (review round 2 #6)', () => {
  const h = harness();
  speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 4, onset_ms: 90 });
  h.advance(DUCK_AFTER_MS + 100);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 4, silence_ms: 700, voiced_ms: 450 });
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck']);
  h.advance(500);
  h.conv.stt({ type: 'final', utterance: 4, text: 'Para.', confidence: 0.9 });
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck', 'stop']);
});

test('aec: a lowered voice never stays low if the transcript does not come', () => {
  const h = harness();
  speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 5, onset_ms: 90 });
  h.advance(DUCK_AFTER_MS + 100);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 5, silence_ms: 700, voiced_ms: 450 });
  h.advance(3500);
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck', 'unduck']);
});

test('answering Claude\'s question never mutes what it says next (review round 2 #1)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Necesito tu permiso para borrar la carpeta.');
  h.say('Sí, adelante.');
  h.conv.streamSentence('Hecho, la he borrado.');
  assert.ok(streamed.some(s => s.action === 'append' && s.text === 'Hecho, la he borrado.'));
});

test('leaving a call mid-sentence hands back what Claude had not said yet (review round 2 #4)', () => {
  const h = harness();
  const unheard = [];
  h.conv.on('unheard', u => unheard.push(u));
  h.conv.setCall(waitingCall({ messages: [assistant('He mirado el login. Falla la cookie. Lo arreglo ahora.')] }));
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'He mirado el login.' });
  h.conv.tts({ type: 'chunk', id, seq: 1, text: 'Falla la cookie.' });
  h.conv.setCall(null);
  assert.deepEqual(unheard, [{ callId: 'c1', text: 'Falla la cookie. Lo arreglo ahora.', done: '', question: false }]);
});

test('Colgar: Claude goes quiet at once, its unheard rest is handed back, nothing new is said (round 3 #1, #6)', () => {
  const h = harness();
  const unheard = [];
  const streamed = [];
  h.conv.on('unheard', u => unheard.push(u));
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(waitingCall({ messages: [assistant('Falla la cookie. Lo arreglo ahora.')] }));
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Falla la cookie.' });
  h.conv.leave();
  assert.deepEqual(unheard, [{ callId: 'c1', text: 'Falla la cookie. Lo arreglo ahora.', done: '', question: false }]);
  assert.ok(h.events('tts').some(t => t.action === 'stop'));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Ya está arreglado.');
  assert.equal(streamed.length, 0, 'nothing is said while the call is leaving');
  h.conv.cancelLeave();
  h.conv.streamSentence('Ya está arreglado.');
  assert.equal(streamed.length, 2, 'the call stayed: Claude talks again');
});

test('a new phrase owns the lowered voice: an older hold never raises it mid-phrase (round 3 #5)', () => {
  const h = harness();
  speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.advance(DUCK_AFTER_MS + 100);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700, voiced_ms: 450 }); // held for its transcript
  h.advance(500);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 2, onset_ms: 90 });
  h.advance(2900); // phrase 1's hold would have expired here
  assert.ok(!h.events('tts').some(t => t.action === 'unduck'), 'still low while the user talks');
});

test('settle waits for the transcript of what the user was saying (review round 2 #3)', async () => {
  let now = 0;
  const conv = new VoiceConversation({ now: () => now, setTimer: (fn, ms) => setTimeout(() => { now += ms; fn(); }, 1), clearTimer: id => clearTimeout(id) });
  conv.setCall(waitingCall({ messages: [] }));
  conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  let settled = false;
  const done = conv.settle(1500).then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(settled, false, 'the transcript is still coming');
  conv.stt({ type: 'final', utterance: 1, text: 'Y luego súbelo.', confidence: 0.9 });
  await done;
  assert.equal(settled, true);
});

// Live request: "una X por si el micrófono escucha algo cuando era silencio, para cancelar lo que se ha
// escuchado antes de que se envíe, o por si se quiere empezar a hablar desde el principio".
test('✕ throws away what was heard before it is sent', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.advance(600);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 1, text: 'Gracias.', confidence: 0.7 }); // noise taken for words
  h.conv.discardDraft();
  h.advance(10_000);
  assert.equal(h.events('commit').length, 0);
});

test('✕ also drops the phrase still being transcribed; what is said next starts afresh', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.advance(800);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.conv.discardDraft(); // its transcript has not come yet
  h.conv.stt({ type: 'speech', state: 'start', utterance: 2, onset_ms: 90 });
  h.conv.stt({ type: 'final', utterance: 1, text: 'Esto no era para Claude.', confidence: 0.9 });
  h.advance(900);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 2, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 2, text: 'Revisa el login.', confidence: 0.9 });
  h.advance(10_000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Revisa el login.']);
});

test('✕ after a noise cut Claude: Claude goes on', () => {
  const h = harness();
  const { streamed, id } = (() => {
    const streamedOut = [];
    h.conv.on('speak-stream', s => streamedOut.push(s));
    h.conv.setEchoCancelled(true);
    h.conv.setCall(waitingCall({ messages: [] }));
    h.conv.streamTurnStart();
    h.conv.streamSentence('Uso la skill de brainstorming.');
    const first = streamedOut[0].id;
    h.conv.tts({ type: 'chunk', id: first, seq: 0, text: 'Uso la skill de brainstorming.' });
    return { streamed: streamedOut, id: first };
  })();
  h.conv.stt({ type: 'speech', state: 'start', utterance: 7, onset_ms: 90 });
  h.advance(BARGE_CONFIRM_MS + 50);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 7, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 7, text: 'Ah, sí, sí.', confidence: 0.8 });
  assert.ok(h.events('tts').some(t => t.action === 'stop'));
  h.conv.discardDraft();
  assert.ok(streamed.some(s => s.id !== id && s.action === 'start'), 'Claude picks up again');
});

test('✕: what Claude was holding back while the user talked is said (round 4 #3)', () => {
  const h = harness();
  h.conv.setCall(waitingCall({ messages: [] }));
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.conv.setCall(waitingCall({ interactionKind: 'ask', messages: [assistant('¿Supabase o Neon?', 5)] }));
  assert.equal(h.events('speak').length, 0, 'not over the user');
  h.conv.discardDraft();
  assert.deepEqual(h.events('speak').map(s => s.text), ['¿Supabase o Neon?']);
});

test('✕ never drops phrases of a restarted recognizer that reuse old ids (round 4 #4)', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 1, text: 'Ruido.', confidence: 0.6 });
  h.conv.stt({ type: 'speech', state: 'start', utterance: 2, onset_ms: 90 });
  h.conv.discardDraft();
  h.conv.stt({ type: 'ready' }); // the worker restarted: ids from 1 again
  h.conv.stt({ type: 'speech', state: 'start', utterance: 2, onset_ms: 90 });
  h.advance(900);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 2, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 2, text: 'Revisa el login.', confidence: 0.9 });
  h.advance(10_000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Revisa el login.']);
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

// ── Streamed answers (controlled session): Claude talks while it writes ─────────────────────

test('stream: sentences are spoken as they arrive, in one utterance', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(waitingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Google funciona.');
  h.conv.streamSentence('Apple falla por la configuración.');
  h.conv.streamTurnEnd();
  assert.deepEqual(streamed.map(s => s.action), ['start', 'append', 'append', 'end']);
  assert.equal(new Set(streamed.map(s => s.id)).size, 1);
  assert.equal(h.conv.playing.text, 'Google funciona. Apple falla por la configuración.');
});

test('stream: after the user cuts Claude, later sentences are kept for "sigue", not spoken', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(waitingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Google funciona.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Google funciona.' });
  h.conv.stt({ type: 'speech', state: 'start', onset_ms: 90 });
  h.conv.stt({ type: 'partial', text: 'espera un segundo' });
  h.conv.streamSentence('Apple falla por la configuración.');
  assert.equal(streamed.filter(s => s.action === 'append').length, 1, 'nothing more is spoken');
  h.conv.streamTurnEnd();
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.say('Sigue.');
  h.advance(3000);
  assert.equal(h.events('speak').at(-1).text, 'Google funciona. Apple falla por la configuración.');
});

// Live test 2026-11-02: switching windows (clicks, keys) cut Claude for the rest of a long turn.
function streamingAec(h) {
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setEchoCancelled(true);
  h.conv.setCall(waitingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Uso la skill de brainstorming.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Uso la skill de brainstorming.' });
  const noise = () => {
    h.conv.stt({ type: 'speech', state: 'start', utterance: 7, onset_ms: 90 });
    h.advance(SUSTAINED_MS + 50);
    h.conv.stt({ type: 'speech', state: 'end', utterance: 7, silence_ms: 700, voiced_ms: 400 });
  };
  return { streamed, id, noise };
}

test('aec stream: a noise with no words that cut Claude lets it go on talking', () => {
  const h = harness();
  const failures = [];
  h.conv.on('failure', f => failures.push(f));
  const { streamed, id, noise } = streamingAec(h);
  noise();
  assert.ok(h.events('tts').some(t => t.action === 'stop'), 'the cut itself still happens at once');
  h.conv.streamSentence('Primero exploro el proyecto.');
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.advance(400);
  h.conv.stt({ type: 'rejected', utterance: 7 });
  const again = streamed.filter(s => s.id !== id);
  assert.equal(again[0].action, 'start');
  assert.equal(again[1].text, 'Uso la skill de brainstorming. Primero exploro el proyecto.', 'from the sentence that was cut');
  h.conv.streamSentence('El agente ya está mirando.');
  assert.equal(streamed.at(-1).text, 'El agente ya está mirando.', 'the rest of the turn is spoken again');
  assert.equal(streamed.at(-1).id, again[0].id);
  assert.deepEqual(failures, ['false_speech_start']);
});

test('stream: going back to a call after hanging up hears Claude again (no cut carried over)', () => {
  const h = harness();
  const { streamed, id } = streamingAec(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 9, onset_ms: 90 });
  h.conv.stt({ type: 'final', utterance: 9, text: 'Espera.', confidence: 0.9 }); // a real cut
  h.conv.setCall(null); // hung up
  h.conv.setCall(waitingCall({ messages: [], awaitingClaude: true, waiting: false }));
  h.conv.streamSentence('Ya está compilada.');
  assert.ok(streamed.some(s => s.id !== id && s.action === 'append' && s.text === 'Ya está compilada.'));
});

test('aec stream: once the user sends something, an old noise no longer brings Claude back (#10)', () => {
  const h = harness();
  const { streamed, id, noise } = streamingAec(h);
  noise();
  h.conv.submitTyped('Mejor cuéntame otra cosa.');
  h.conv.stt({ type: 'rejected', utterance: 7 });
  assert.ok(!streamed.some(s => s.id !== id), 'the old answer is not resumed');
});

test('aec stream: a garbled guess ("Música" 0.35) is noise too', () => {
  const h = harness();
  const { streamed, id, noise } = streamingAec(h);
  noise();
  h.advance(400);
  h.conv.stt({ type: 'final', utterance: 7, text: 'Música', confidence: 0.35 });
  assert.ok(streamed.some(s => s.id !== id && s.action === 'start'));
});

test('aec stream: real words keep Claude quiet and wait for the user', () => {
  const h = harness();
  const { streamed, id, noise } = streamingAec(h);
  noise();
  h.advance(400);
  h.conv.stt({ type: 'final', utterance: 7, text: 'Espera, espera.', confidence: 0.9 });
  h.conv.streamSentence('Primero exploro el proyecto.');
  assert.equal(streamed.filter(s => s.id !== id).length, 0);
});

test('aec: a noise too short to be transcribed resumes as soon as it ends', () => {
  const h = harness();
  const id = speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 3, onset_ms: 90 });
  h.advance(SUSTAINED_MS + 20);
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.conv.stt({ type: 'speech', state: 'end', utterance: 3, silence_ms: 700, voiced_ms: 300 });
  assert.equal(h.events('speak').at(-1).text, 'He terminado el cambio.');
  assert.equal(h.events('speak').length, 2);
});

test('echo is judged by the phrase each transcript belongs to', () => {
  const h = harness();
  h.conv.setCall(waitingCall({ messages: [assistant('¿Prefieres Supabase o Neon para la base de datos?')] }));
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: '¿Prefieres Supabase o Neon para la base de datos?' });
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 }); // Claude's voice in the mic
  h.advance(1500);
  h.conv.tts({ type: 'end', id });
  h.advance(700);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.advance(300);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 2, onset_ms: 90 }); // the user answers
  h.advance(400);
  h.conv.stt({ type: 'final', utterance: 1, text: 'Prefieres Supabase o Neon para la base de datos', confidence: 0.8 });
  h.advance(600);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 2, silence_ms: 700 });
  h.advance(300);
  h.conv.stt({ type: 'final', utterance: 2, text: 'Neon.', confidence: 0.9 });
  h.advance(3000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Neon.']);
});

// ── Full-day review (2026-11-03) ─────────────────────────────────────────────

test('✕ with Windows dictation: the next phrase, after the recognizer restarted, is kept (review C2)', () => {
  const h = harness();
  h.conv.setCall(workingCall());
  h.conv.stt({ type: 'partial', text: 'ruido que no era nada' }); // no phrase ids, no voice events
  h.conv.discardDraft({ cutting: true });
  h.conv.stt({ type: 'final', text: 'ruido que no era nada', confidence: 0.6 }); // already in the pipe: dropped
  h.conv.stt({ type: 'paused' });
  h.conv.stt({ type: 'listening' });
  h.conv.stt({ type: 'partial', text: 'Revisa el login' });
  h.conv.stt({ type: 'final', text: 'Revisa el login.', confidence: 0.9 });
  h.advance(8000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Revisa el login.']);
});

test('✕ with Whisper: transcripts of the cut phrase are dropped, a new phrase is kept (review C1)', () => {
  const h = harness();
  h.conv.setCall(workingCall());
  h.conv.stt({ type: 'speech', state: 'start', utterance: 4, onset_ms: 90 });
  h.conv.stt({ type: 'partial', utterance: 4, text: 'tecleo tecleo' });
  h.conv.discardDraft({ cutting: true });
  h.conv.stt({ type: 'speech', state: 'end', utterance: 4, cancelled: true });
  h.conv.stt({ type: 'cut' });
  h.conv.stt({ type: 'final', utterance: 4, text: 'tecleo tecleo', confidence: 0.7 });
  h.conv.stt({ type: 'speech', state: 'start', utterance: 5, onset_ms: 90 });
  h.conv.stt({ type: 'speech', state: 'end', utterance: 5, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 5, text: 'Mira los tests.', confidence: 0.9 });
  h.advance(8000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Mira los tests.']);
});

test('✕ while a voice is lowering Claude: Claude is not cut afterwards (review C4)', () => {
  const h = harness();
  speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.advance(DUCK_AFTER_MS + 300);
  h.conv.discardDraft({ cutting: true });
  h.advance(SUSTAINED_MS);
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck', 'unduck']);
});

test('muting mid-phrase does not cut Claude later, and says what it was holding (review C4, C8)', () => {
  const h = harness();
  speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.advance(DUCK_AFTER_MS + 100);
  h.conv.setMuted(true);
  h.advance(SUSTAINED_MS);
  assert.ok(!h.events('tts').some(t => t.action === 'stop'));

  const g = harness();
  g.conv.setCall(workingCall({ messages: [] }));
  g.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  g.conv.setCall(workingCall({ messages: [assistant('Ya está compilado.', 9)] }));
  assert.equal(g.events('speak').length, 0, 'held while the user talks');
  g.conv.setMuted(true);
  assert.equal(g.events('speak').at(-1)?.text, 'Ya está compilado.');
});

test('hanging up after a noise cut Claude: the rest is handed back, not lost (review C3)', () => {
  const h = harness();
  const unheard = [];
  h.conv.on('unheard', u => unheard.push(u));
  const id = speakingCall(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 3, onset_ms: 90 });
  h.advance(SUSTAINED_MS + 20);
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.conv.leave();
  h.conv.stt({ type: 'speech', state: 'end', utterance: 3, silence_ms: 700 });
  h.conv.stt({ type: 'rejected', utterance: 3 });
  assert.deepEqual(unheard.map(u => u.text), ['He terminado el cambio.']);
  assert.equal(h.events('speak').length, 1, 'nothing is said while hanging up');
});

test('"espera" then En espera: nothing is sent, and Claude says the rest on return (review B1, C3)', () => {
  const h = harness();
  const unheard = [];
  h.conv.on('unheard', u => unheard.push(u));
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo subir los cambios a GitHub?')] }));
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: '¿Puedo subir los cambios a GitHub?' });
  h.say('Espera.');
  h.advance(3000);
  assert.equal(h.events('commit').length, 0, 'a lone "espera" is never an answer');
  h.conv.leave();
  h.conv.flushDraft('pones la llamada en espera');
  assert.equal(h.events('commit').length, 0, 'not even when leaving');
  assert.deepEqual(unheard.map(u => u.question), [true], 'the question is asked again, whole');
});

test('leave(): handing the rest back cannot make Claude start speaking again (review A2)', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'He terminado el cambio.' });
  // main.js: the unheard text bumps the message and the broker change calls setCall at once.
  h.conv.on('unheard', () => h.conv.setCall(waitingCall({ messages: [{ ...assistant('He terminado el cambio.'), rev: 1 }] })));
  h.conv.leave();
  assert.equal(h.events('speak').length, 1, 'nothing new started while leaving');
  h.conv.setCall(null);
  h.conv.setCall(waitingCall({ messages: [{ ...assistant('He terminado el cambio.'), rev: 1 }] }));
  assert.equal(h.events('speak').length, 2, 'said on picking up');
});

test('"sigue" after a cut finds the sentence even when the voice normalized it (review C5)', () => {
  const h = harness();
  h.conv.setEchoCancelled(true);
  h.conv.setCall(waitingCall({ messages: [assistant('Primero compilo. Tardará 30 s más o menos. Luego subo «todo».')] }));
  const { id } = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id, seq: 1, text: 'Tardará 30 segundos más o menos.' });
  h.say('Para.');
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.advance(3000);
  h.say('Sigue.');
  h.advance(3000);
  assert.equal(h.events('speak').at(-1).text, 'Tardará 30 s más o menos. Luego subo «todo».');
});

test('the Windows fallback voice keeps the echo filter on until its echo is gone (review C6)', () => {
  const h = harness();
  h.conv.setEchoCancelled(true);
  h.conv.setCall(waitingCall({ messages: [assistant('He revisado la configuración del servidor.')] }));
  const { id } = h.events('speak')[0];
  h.conv.setEchoCancelled(false); // the renderer fell back to speechSynthesis
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'He revisado la configuración del servidor.' });
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.advance(1500);
  h.conv.tts({ type: 'end', id });
  h.conv.setEchoCancelled(true); // fallback over
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.advance(400);
  h.conv.stt({ type: 'final', utterance: 1, text: 'revisado la configuración del servidor', confidence: 0.8 });
  h.advance(6000);
  assert.equal(h.events('commit').length, 0, "Claude's own words are not the user's");
});

test('a recognizer restart mid-phrase closes that phrase: Claude is not held back forever (review C12)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.conv.setCall(workingCall({ messages: [assistant('Ya está compilado.', 9)] }));
  assert.equal(h.events('speak').length, 0);
  h.conv.stt({ type: 'ready', engine: 'whisper' });
  assert.equal(h.events('speak').at(-1)?.text, 'Ya está compilado.');
});

// Claude works between sentences with its streamed answer still open: nothing is audible then.
function streamingIdle(h) {
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setEchoCancelled(true);
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Voy a revisar los tests.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Voy a revisar los tests.' });
  h.conv.tts({ type: 'idle', id });
  return { streamed, id };
}

test('stream: talking while Claude works in silence is not an interruption (review: idle stream)', () => {
  const h = harness();
  const { streamed, id } = streamingIdle(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.advance(SUSTAINED_MS + 100);
  h.conv.stt({ type: 'partial', utterance: 1, text: 'y también mira el login' });
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 1, text: 'Y también mira el login.', confidence: 0.9 });
  h.advance(6000);
  assert.ok(!h.events('tts').some(t => t.action === 'stop' || t.action === 'duck'), 'nothing to cut');
  assert.deepEqual(h.events('commit').map(c => c.text), ['Y también mira el login.'], 'sent at once, not after the turn');
  h.conv.streamSentence('He revisado los tests y el login.');
  assert.equal(streamed.at(-1).text, 'He revisado los tests y el login.', 'the rest of the answer is heard');
  assert.equal(streamed.at(-1).id, id);
});

test('stream: a cut keeps the rest of that message for "sigue", the next message is heard (review)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Voy a revisar los tests.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Voy a revisar los tests.' });
  h.say('Y también el login.');
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.conv.streamSentence('Empiezo por los unitarios.');
  assert.ok(!streamed.some(s => s.text === 'Empiezo por los unitarios.'), 'the cut message stays cut');
  h.conv.streamMessageStart();
  h.conv.streamSentence('Sigo con otra cosa.');
  assert.ok(!streamed.some(s => s.text === 'Sigo con otra cosa.'), "not while the user's words are still being decided");
  h.advance(4000); // sent
  h.conv.streamMessageStart(); // Claude's next message (after the user's words reached it)
  h.conv.streamSentence('Tests y login revisados.');
  assert.equal(streamed.at(-1).text, 'Tests y login revisados.');
});

test('stream: a question waits for the sentence Claude is saying instead of cutting it (review A3)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Voy a subir los cambios.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Voy a subir los cambios.' });
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo hacer push?', 9)] }));
  assert.ok(!h.events('tts').some(t => t.action === 'stop'), 'the sentence is not cut');
  assert.equal(h.events('speak').length, 0);
  h.conv.tts({ type: 'idle', id });
  assert.equal(h.events('speak').at(-1).text, '¿Puedo hacer push?');
});

test('words begun before a permission reached the user are not its answer (review A1)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.advance(600);
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo hacer git push --force?', 9)] }));
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 1, text: 'Vale, gracias, luego hablamos.', confidence: 0.9 });
  h.advance(6000);
  const [early] = h.events('commit');
  assert.equal(early.route, 'steer');
  assert.equal(early.early, true);
  h.say('Sí, adelante.');
  h.advance(6000);
  const answer = h.events('commit').at(-1);
  assert.equal(answer.route, 'answer');
  assert.equal(answer.early, false);
});

test('a permission that arrives while the user hangs up is not answered by the flushed words (review A1)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.advance(600);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 1, text: 'Vale, gracias, luego hablamos.', confidence: 0.9 });
  h.conv.leave();
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo borrar la rama?', 9)] }));
  h.conv.flushDraft('cuelgas');
  const [commit] = h.events('commit');
  assert.equal(commit.route, 'steer');
  assert.equal(commit.early, true);
});

test('a question answered with a button before it was said is not said afterwards (live test 2026-11-03)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Voy a esperar un poco.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Voy a esperar un poco.' });
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo ejecutar ping?', 9)] }));
  h.conv.setCall(workingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo ejecutar ping?', 9)] })); // "Permitir"
  h.conv.tts({ type: 'idle', id });
  h.conv.tts({ type: 'end', id });
  assert.equal(h.events('speak').length, 0);
});

// ── Regression review of the full-day fixes (2026-11-03, round 2) ──────────────

test('a cough long before a permission does not make the answer to it "early" (round 2 #1)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.conv.stt({ type: 'rejected', utterance: 1 }); // a cough: no words
  h.advance(30000);
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo hacer push?', 9)] }));
  h.advance(2000);
  h.say('Sí, adelante.');
  h.advance(5000);
  const answer = h.events('commit').at(-1);
  assert.equal(answer.route, 'answer');
  assert.equal(answer.early, false);
});

test('a question kept while Claude finishes its sentence is not answered by words said to that sentence (round 2 #2)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Voy a subir los cambios a la rama principal.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Voy a subir los cambios a la rama principal.' });
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo hacer git push --force?', 9)] }));
  h.say('Vale, perfecto.'); // to the sentence: the question has not been said yet
  h.advance(4000);
  const [first] = h.events('commit');
  assert.equal(first.early, true);
  assert.equal(first.route, 'steer');
  h.conv.tts({ type: 'idle', id });
  assert.equal(h.events('speak').at(-1)?.text, '¿Puedo hacer git push --force?', 'then the question is asked');
  h.conv.tts({ type: 'end', id: h.events('speak').at(-1).id });
  h.say('Sí.');
  h.advance(4000);
  assert.equal(h.events('commit').at(-1).route, 'answer');
});

test('without echo cancellation, a quiet open stream does not swallow "no, para" as echo (round 2 #3)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Voy a revisar Google.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Voy a revisar Google.' });
  h.conv.tts({ type: 'idle', id });
  h.advance(30000);
  h.say('No, para.');
  h.advance(4000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['No, para.']);
});

test('a sentence added to a quiet stream counts as Claude talking until it plays (round 2 #4)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Primero miro el parser.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Primero miro el parser.' });
  h.conv.tts({ type: 'idle', id });
  h.conv.streamSentence('Hay un fallo en el parser, lo arreglo.');
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo editar el parser?', 9)] }));
  assert.ok(!h.events('tts').some(t => t.action === 'stop'), 'the new sentence is not cut by the question');
  h.advance(6000); // it never played (no audio came): Claude is not "talking" forever
  assert.equal(h.events('speak').at(-1)?.text, '¿Puedo editar el parser?');
});

test('✕ with a quiet open stream says the question it was keeping (round 2 #5)', () => {
  const h = harness();
  streamingIdle(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo borrar la caché?', 9)] }));
  assert.equal(h.events('speak').length, 0);
  h.conv.discardDraft({ cutting: true });
  assert.equal(h.events('speak').at(-1)?.text, '¿Puedo borrar la caché?');
});

test('a transcript that never comes does not keep Claude quiet (round 2 #6)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.conv.setCall(workingCall({ messages: [assistant('Ya está compilado.', 9)] }));
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 }); // its transcript is lost
  assert.equal(h.events('speak').length, 0);
  h.advance(4000);
  assert.equal(h.events('speak').at(-1)?.text, 'Ya está compilado.');

  const g = harness();
  g.conv.setCall(workingCall({ messages: [] }));
  g.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  g.conv.discardDraft({ cutting: true });
  g.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 }); // its end was already on its way
  g.conv.setCall(workingCall({ messages: [assistant('Ya está compilado.', 9)] }));
  assert.equal(g.events('speak').at(-1)?.text, 'Ya está compilado.', 'a thrown-away phrase expects no transcript');
});

test('a noise still being judged keeps the cut message when Claude starts the next one (round 2 #7)', () => {
  const h = harness();
  const { streamed, id, noise } = streamingAec(h);
  noise();
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.conv.streamMessageStart();
  h.conv.streamSentence('Ahora miro los tests.');
  h.conv.stt({ type: 'rejected', utterance: 7 });
  const again = streamed.filter(s => s.id !== id && s.action === 'append').map(s => s.text);
  assert.deepEqual(again, ['Uso la skill de brainstorming.', 'Ahora miro los tests.'], 'the cut sentence, then the new message');
});

test('words flushed after a result nobody heard are not a reply to it (round 2 #8)', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  h.conv.tts({ type: 'end', id: h.events('speak')[0].id });
  h.say('Y luego sube los cambios.');
  h.conv.leave();
  h.conv.flushDraft('cuelgas', { early: true });
  const [commit] = h.events('commit');
  assert.equal(commit.route, 'steer');
  assert.equal(commit.early, true);
});

test('"sigue" after a real cut goes on inside the stream: later sentences are heard (round 2 #9)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setEchoCancelled(true);
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Uno es esto.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Uno es esto.' });
  h.say('Espera, espera.');
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.advance(5000);
  h.say('Sigue.');
  h.advance(3000);
  assert.equal(h.events('commit').length, 0, '"espera… sigue" is about the voice of Claude: nothing is sent');
  h.conv.streamSentence('Dos es aquello.');
  const texts = streamed.filter(s => s.id !== id && s.action === 'append').map(s => s.text);
  assert.deepEqual(texts, ['Uno es esto.', 'Dos es aquello.']);
});

test('a lone "espera" while Claude works quietly holds what it says next (round 2 #10)', () => {
  const h = harness();
  const { streamed, id } = streamingIdle(h);
  h.say('Espera.');
  h.advance(5000);
  h.conv.streamSentence('Ya tengo el resultado.');
  assert.ok(!streamed.some(s => s.text === 'Ya tengo el resultado.'), 'Claude waits');
  h.say('Sigue.');
  h.advance(3000);
  assert.ok(streamed.some(s => s.id !== id && /Ya tengo el resultado/.test(s.text || '')), 'and goes on with "sigue"');
});

test('Claude talking again over a user who is already speaking is weighed as a barge-in (round 2 #10)', () => {
  const h = harness();
  const { id } = streamingIdle(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.conv.streamSentence('Ya está.');
  h.conv.tts({ type: 'chunk', id, seq: 1, text: 'Ya está.' });
  h.advance(DUCK_AFTER_MS + 10);
  assert.deepEqual(h.events('tts').map(t => t.action), ['duck']);
});

// ── Regression review, round 3 (2026-11-03) ───────────────────────────────────

test('a message Claude starts while the user is still adding something is heard right after (round 3 #1)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setEchoCancelled(true);
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Uso la rama principal.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Uso la rama principal.' });
  h.say('No, para, usa la otra rama.');
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.advance(3000); // sent
  h.conv.stt({ type: 'speech', state: 'start', utterance: 9, onset_ms: 90 }); // the user adds something
  h.conv.streamMessageStart();
  h.conv.streamSentence('Vale, uso la rama de desarrollo.');
  assert.ok(!streamed.some(s => s.text === 'Vale, uso la rama de desarrollo.'), 'not over the user');
  h.conv.stt({ type: 'speech', state: 'end', utterance: 9, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 9, text: 'Y no toques los tests.', confidence: 0.9 });
  h.advance(4000);
  assert.ok(streamed.some(s => s.text === 'Vale, uso la rama de desarrollo.'), 'heard once the user is done');
});

test('Claude\'s answer after a lone "espera" while it worked is heard when the hold ends (round 3 #1)', () => {
  const h = harness();
  const { streamed } = streamingIdle(h);
  h.say('Espera.');
  h.advance(5000);
  h.conv.streamMessageStart();
  h.conv.streamSentence('Listo, pasan todos menos uno del login.');
  assert.ok(!streamed.some(s => s.text === 'Listo, pasan todos menos uno del login.'));
  h.advance(9000); // the hold ends ("Espera." is sent)
  assert.ok(streamed.some(s => s.text === 'Listo, pasan todos menos uno del login.'));
});

test('a sentence that never plays does not keep the user\'s words waiting (round 3 #2)', () => {
  const h = harness();
  const { id } = streamingIdle(h);
  h.conv.streamSentence('Esto no llega a sonar.');
  h.say('Mira también el login.');
  h.advance(8000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Mira también el login.']);
  assert.ok(id);
});

test('without echo cancellation, words said while Claude worked quietly are the user\'s (round 3 #3)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Voy a cambiar el parser y los tests.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Voy a cambiar el parser y los tests.' });
  h.conv.tts({ type: 'idle', id });
  h.advance(20000);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 3, onset_ms: 90 });
  h.advance(1200);
  h.conv.streamSentence('Empiezo ya.'); // Claude goes on before the transcript arrives
  h.conv.stt({ type: 'speech', state: 'end', utterance: 3, silence_ms: 700 });
  h.conv.tts({ type: 'chunk', id, seq: 1, text: 'Empiezo ya.' });
  h.conv.stt({ type: 'final', utterance: 3, text: 'Solo los tests, el parser no.', confidence: 0.9 });
  h.conv.tts({ type: 'end', id });
  h.advance(5000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Solo los tests, el parser no.']);
});

test('a partial left on screen by a recognizer restart does not hold Claude back (round 3 #4)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.stt({ type: 'partial', text: 'y también mira' });
  h.conv.setCall(workingCall({ messages: [assistant('Ya está compilado.', 9)] }));
  assert.equal(h.events('speak').length, 0);
  h.conv.stt({ type: 'ready', engine: 'winrt' });
  assert.equal(h.events('speak').at(-1)?.text, 'Ya está compilado.');
});

test('a question kept while the user talks is not said before their transcript arrives (round 3 #5)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.advance(4000); // a long phrase
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo hacer push?', 9)] }));
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.advance(2600); // Whisper is slow
  assert.equal(h.events('speak').length, 0, 'still waiting for the transcript');
  h.conv.stt({ type: 'final', utterance: 1, text: 'Y luego mira los tests de integración.', confidence: 0.9 });
  h.advance(4000);
  assert.equal(h.events('commit')[0].early, true);
  assert.equal(h.events('speak').at(-1)?.text, '¿Puedo hacer push?', 'then the question is asked, whole');
  assert.ok(!h.events('tts').some(t => t.action === 'stop'));
});

test('a failed partial or guess does not drop the transcript still to come (round 3 #7)', () => {
  const h = harness();
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Borro la base de datos?')] }));
  h.conv.tts({ type: 'end', id: h.events('speak')[0].id });
  h.say('Sí.');
  h.conv.stt({ type: 'speech', state: 'start', utterance: 2, onset_ms: 90 });
  h.advance(900);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 2, silence_ms: 700 });
  h.conv.stt({ type: 'error', engine: 'whisper', message: 'boom', utterance: 2, kind: 'spec' });
  h.advance(400);
  h.conv.stt({ type: 'final', utterance: 2, text: 'Pero solo la de pruebas, no la de producción.', confidence: 0.9 });
  h.advance(5000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Sí. Pero solo la de pruebas, no la de producción.']);
});

test('"espera" then "sigue" over a quiet stream does not repeat what was already heard (round 3 #8)', () => {
  const h = harness();
  const { streamed } = streamingIdle(h);
  h.say('Espera.');
  h.advance(5000);
  h.say('Sigue.');
  h.advance(3000);
  assert.equal(streamed.filter(s => s.text === 'Voy a revisar los tests.').length, 1);
});

test('"repite" while Claude works quietly repeats its last sentence, not an older message (round 3 #9)', () => {
  const h = harness();
  const { streamed } = streamingIdle(h);
  h.say('Repite.');
  h.advance(3000);
  assert.equal(streamed.at(-1).text, 'Voy a revisar los tests.');
});

test('a phrase dictated into the text box does not make a later answer "early" (round 3 #10)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.setTyping(true);
  h.say('Esto va al cuadro.');
  h.conv.setTyping(false);
  h.advance(30000);
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo hacer push?', 9)] }));
  h.conv.tts({ type: 'end', id: h.events('speak').at(-1).id });
  h.say('Sí.');
  h.advance(4000);
  const answer = h.events('commit').at(-1);
  assert.equal(answer.route, 'answer');
  assert.equal(answer.early, false);
});

// ── Regression review, round 4 (2026-11-03): nothing of Claude's cuts what is being heard ──

test('an answer released after the user spoke is not cut by the next turn (round 4 #1a)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.conv.streamMessageStart();
  h.conv.streamSentence('Ya está desplegado.');
  h.conv.streamTurnEnd(); // the turn ended while the user talked
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 1, text: 'Y ahora revisa los logs.', confidence: 0.9 });
  h.advance(4000); // sent: a new turn starts
  const answer = h.events('speak').at(-1);
  assert.equal(answer.text, 'Ya está desplegado.');
  h.conv.tts({ type: 'chunk', id: answer.id, seq: 0, text: 'Ya está desplegado.' });
  h.conv.streamTurnStart();
  h.conv.streamSentence('Miro los logs.');
  assert.ok(!h.events('tts').some(t => t.action === 'stop'), 'the answer is not cut');
  assert.ok(!streamed.some(s => s.text === 'Miro los logs.'));
  h.conv.tts({ type: 'end', id: answer.id });
  assert.ok(streamed.some(s => s.text === 'Miro los logs.'), 'then the new turn is heard');
});

test('a kept message waits for the one being said instead of cutting it (round 4 #1b, #9)', () => {
  const h = harness();
  h.conv.setCall(waitingCall());
  const first = h.events('speak')[0];
  h.conv.tts({ type: 'chunk', id: first.id, seq: 0, text: 'He terminado el cambio.' });
  h.conv.setCall(waitingCall({ messages: [assistant('He terminado el cambio.'), assistant('Mi sesión se ha cerrado.', 5)] }));
  assert.ok(!h.events('tts').some(t => t.action === 'stop'));
  assert.equal(h.events('speak').length, 1);
  h.conv.tts({ type: 'end', id: first.id });
  assert.equal(h.events('speak').at(-1).text, 'Mi sesión se ha cerrado.');
});

test('"espera" over a sentence keeps the whole message for "sigue", not a fragment after a correction (round 4 #2)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setEchoCancelled(true);
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Voy a borrar la tabla users.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Voy a borrar la tabla users.' });
  h.say('Espera.');
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.conv.streamSentence('Luego la vuelvo a crear.');
  h.advance(5000); // the hold
  h.conv.streamSentence('Después actualizo el esquema.');
  h.say('No borres la tabla, solo vacíala.');
  h.advance(4000);
  assert.ok(!streamed.some(s => s.id !== id && s.text === 'Después actualizo el esquema.'), 'no fragment after the correction');
  assert.match(h.conv.interrupted?.text || '', /Después actualizo el esquema/, 'kept for "sigue"');
});

test('"sí, adelante" to Claude\'s spoken question is sent even if Claude\'s next message is waiting (round 4 #3)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('¿Lo subo a producción?');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: '¿Lo subo a producción?' });
  h.conv.tts({ type: 'idle', id });
  h.conv.stt({ type: 'speech', state: 'start', utterance: 2, onset_ms: 90 });
  h.conv.streamMessageStart(); // Claude's next message starts meanwhile: it waits
  h.conv.stt({ type: 'speech', state: 'end', utterance: 2, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 2, text: 'Sí, adelante.', confidence: 0.9 });
  h.advance(4000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Sí, adelante.']);
});

test('without echo cancellation, Claude\'s echo joining a breath while it was quiet is still its echo (round 4 #4)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Primero miro la configuración.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Primero miro la configuración.' });
  h.conv.tts({ type: 'idle', id });
  h.advance(5000);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 4, onset_ms: 90 }); // a breath
  h.advance(300);
  h.conv.streamSentence('El servidor responde bien ahora.');
  h.conv.tts({ type: 'chunk', id, seq: 1, text: 'El servidor responde bien ahora.' });
  h.advance(2000);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 4, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 4, text: 'el servidor responde bien ahora', confidence: 0.8 });
  h.conv.tts({ type: 'end', id });
  h.advance(5000);
  assert.equal(h.events('commit').length, 0);
});

test('a cut whose transcript never comes does not hold Claude\'s next message for ever (round 4 #5)', () => {
  const h = harness();
  const { streamed, id, noise } = streamingAec(h);
  noise();
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.conv.stt({ type: 'ready', engine: 'whisper' }); // the recognizer restarted: that transcript is gone
  h.conv.streamMessageStart();
  h.conv.streamSentence('Ahora miro los tests.');
  h.advance(4000);
  assert.ok(streamed.some(s => s.text === 'Ahora miro los tests.'));
});

test('Windows dictation stopping mid-phrase does not keep the draft or Claude waiting (round 4 #7)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.stt({ type: 'final', text: 'Mira también el registro.', confidence: 0.9 });
  h.conv.stt({ type: 'partial', text: 'y luego' });
  h.conv.setCall(workingCall({ messages: [assistant('Ya está compilado.', 9)] }));
  h.conv.stt({ type: 'error', message: 'El dictado de Windows se ha detenido' });
  h.conv.stt({ type: 'listening' });
  h.advance(8000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Mira también el registro.']);
  assert.equal(h.events('speak').at(-1)?.text, 'Ya está compilado.');
});

test('a late transcript of a phrase said while Claude was quiet does not cut Claude going on (round 4 #8)', () => {
  const h = harness();
  const { streamed, id } = streamingIdle(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 5, onset_ms: 90 });
  h.advance(800);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 5, silence_ms: 700 });
  h.advance(200);
  h.conv.streamSentence('Ya tengo el resultado.');
  h.conv.tts({ type: 'chunk', id, seq: 1, text: 'Ya tengo el resultado.' });
  h.advance(1500);
  h.conv.stt({ type: 'final', utterance: 5, text: 'Y mira el login también.', confidence: 0.9 });
  assert.ok(!h.events('tts').some(t => t.action === 'stop'), 'Claude is not cut');
  h.conv.tts({ type: 'end', id });
  h.advance(7000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Y mira el login también.']);
  assert.ok(streamed.length);
});

// ── Regression review, round 5 (2026-11-03) ───────────────────────────────────

test('a question added in the same millisecond as Claude\'s silent message is still said (round 5 #1)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [{ role: 'assistant', text: 'Necesito instalar una dependencia.', speech: '', silent: true, at: 50, id: 1 }] }));
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [
    { role: 'assistant', text: 'Necesito instalar una dependencia.', speech: '', silent: true, at: 50, id: 1 },
    { role: 'assistant', text: '¿Puedo ejecutar npm install?', speech: '¿Puedo ejecutar npm install?', at: 50, id: 2 },
  ] }));
  assert.equal(h.events('speak').at(-1)?.text, '¿Puedo ejecutar npm install?');
});

test('a reply begun before a result reached the user tells Claude the result was not heard (round 5 #2)', () => {
  const h = harness();
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.stt({ type: 'speech', state: 'start', utterance: 1, onset_ms: 90 });
  h.conv.setCall(waitingCall({ messages: [assistant('Listo: la migración ha fallado en producción.', 9)] }));
  h.conv.stt({ type: 'speech', state: 'end', utterance: 1, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 1, text: 'Y luego sube los cambios.', confidence: 0.9 });
  h.advance(4000);
  const [commit] = h.events('commit');
  assert.equal(commit.early, true);
  assert.equal(h.events('speak').at(-1)?.text, 'Listo: la migración ha fallado en producción.', 'and the result is still said');
});

test('"no, para" said just before Claude goes on stops it at once (round 5 #3)', () => {
  const h = harness();
  const { id } = streamingIdle(h);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 5, onset_ms: 90 });
  h.advance(900);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 5, silence_ms: 700 });
  h.advance(100);
  h.conv.streamSentence('Borro la carpeta de compilación.');
  h.conv.tts({ type: 'chunk', id, seq: 1, text: 'Borro la carpeta de compilación.' });
  h.advance(900);
  h.conv.stt({ type: 'final', utterance: 5, text: 'No, para, no borres nada.', confidence: 0.9 });
  assert.ok(h.events('tts').some(t => t.action === 'stop'), 'Claude stops');
  h.advance(3000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['No, para, no borres nada.']);
});

test('a noise cut waits for the transcript still on its way before Claude goes on (round 5 #3)', () => {
  const h = harness();
  const { streamed, id, noise } = streamingAec(h);
  noise();
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.conv.stt({ type: 'speech', state: 'start', utterance: 8, onset_ms: 90 }); // the user says something after the cough
  h.conv.stt({ type: 'rejected', utterance: 7 }); // the cough had no words
  assert.ok(!streamed.some(s => s.id !== id), 'not while the user is talking');
  h.conv.stt({ type: 'speech', state: 'end', utterance: 8, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 8, text: 'No, para.', confidence: 0.9 });
  h.advance(3000);
  assert.ok(!streamed.some(s => s.id !== id), 'the cut stands');
  assert.deepEqual(h.events('commit').map(c => c.text), ['No, para.']);
});

test('without echo cancellation, a correction that reuses Claude\'s next words is the user\'s (round 5 #4)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Primero miro el módulo.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Primero miro el módulo.' });
  h.conv.tts({ type: 'idle', id });
  h.advance(5000);
  h.conv.stt({ type: 'speech', state: 'start', utterance: 4, onset_ms: 90 });
  h.advance(500);
  h.conv.streamSentence('Ahora miro los tests de integración del módulo.');
  h.conv.tts({ type: 'chunk', id, seq: 1, text: 'Ahora miro los tests de integración del módulo.' });
  h.advance(1500);
  h.conv.stt({ type: 'speech', state: 'end', utterance: 4, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 4, text: 'Y los tests de integración, también.', confidence: 0.9 });
  h.conv.tts({ type: 'end', id });
  h.advance(7000);
  assert.deepEqual(h.events('commit').map(c => c.text), ['Y los tests de integración, también.']);
});

test('"espera… sigue" before a kept permission was heard resumes Claude\'s voice (round 5 #5)', () => {
  const h = harness();
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setEchoCancelled(true);
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamSentence('Voy a instalar dos paquetes.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Voy a instalar dos paquetes.' });
  h.say('Espera.');
  h.conv.tts({ type: 'end', id, interrupted: true });
  h.advance(5000);
  h.conv.setCall(waitingCall({ interactionKind: 'permission', messages: [assistant('¿Puedo ejecutar npm install?', 9)] }));
  h.conv.stt({ type: 'speech', state: 'start', utterance: 9, onset_ms: 90 });
  h.conv.stt({ type: 'speech', state: 'end', utterance: 9, silence_ms: 700 });
  h.conv.stt({ type: 'final', utterance: 9, text: 'Sigue.', confidence: 0.9 });
  h.advance(3000);
  assert.equal(h.events('commit').length, 0, 'nothing is sent to Claude');
});

test('hand-back splits a finished message from the one being written inside one stream (round 5 #6)', () => {
  const h = harness();
  const unheard = [];
  h.conv.on('unheard', u => unheard.push(u));
  const streamed = [];
  h.conv.on('speak-stream', s => streamed.push(s));
  h.conv.setCall(workingCall({ messages: [] }));
  h.conv.streamTurnStart();
  h.conv.streamMessageStart();
  h.conv.streamSentence('Hay dos tablas sin índice.');
  h.conv.streamMessageStart();
  h.conv.streamSentence('Creo los índices ahora.');
  const { id } = streamed[0];
  h.conv.tts({ type: 'chunk', id, seq: 0, text: 'Hay dos tablas sin índice.' });
  h.conv.leave();
  assert.deepEqual(unheard.map(({ done, text }) => ({ done, text })), [{ done: 'Hay dos tablas sin índice.', text: 'Creo los índices ahora.' }]);
});
