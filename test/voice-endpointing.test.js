const test = require('node:test');
const assert = require('node:assert/strict');
const { LegacyEndpointer } = require('../src/voice/endpointing');

// The legacy policy must keep the renderer's timings up to 8eb1313: it is the voice lab's baseline.
test('legacy: 1.5 s for questions, 3 s for free replies, counted from the end of speech', () => {
  const ask = new LegacyEndpointer({ kind: 'ask' });
  ask.speechStart(0);
  ask.speechEnd(1000);
  ask.final(1600, 'La segunda.');
  assert.equal(ask.deadline, 1600 + 1200, 'never less than 1.2 s visible');
  const free = new LegacyEndpointer({ kind: 'stop' });
  free.speechStart(0);
  free.speechEnd(1000);
  free.final(1600, 'Haz el cambio.');
  assert.equal(free.deadline, 1000 + 3000);
});

test('legacy: words that announce more wait 5 s', () => {
  const p = new LegacyEndpointer({ kind: 'stop' });
  p.speechStart(0);
  p.speechEnd(1000);
  p.final(1500, 'Haz eso y');
  assert.equal(p.deadline, 1000 + 5000);
});

test('legacy: speaking again cancels; low confidence adds nothing', () => {
  const p = new LegacyEndpointer({ kind: 'ask' });
  p.speechStart(0);
  p.speechEnd(1000);
  p.final(1500, 'Orlando', 0.11);
  assert.equal(p.deadline, null);
  p.final(1600, 'Sí.');
  assert.notEqual(p.deadline, null);
  p.speechStart(1700);
  assert.equal(p.deadline, null);
  p.speechEnd(2500);
  p.final(2900, 'Adelante.');
  assert.equal(p.take(), 'Sí. Adelante.');
  assert.equal(p.text(), '');
});

// ── Adaptive policy (Voice First §8): fast for obvious ends, patient with unfinished thoughts ─────
const { AdaptiveEndpointer, fixShortAnswer } = require('../src/voice/endpointing');

function turn(policy, text, { end = 1000, finalAt = 1600, confidence = 0.9 } = {}) {
  policy.speechStart(0);
  policy.speechEnd(end);
  policy.final(finalAt, text, confidence);
  return policy.deadline - finalAt; // wait after the transcript is ready
}

test('adaptive: short answers to a permission or a choice go at once', () => {
  assert.ok(turn(new AdaptiveEndpointer({ kind: 'permission' }), 'Sí.') <= 200);
  assert.ok(turn(new AdaptiveEndpointer({ kind: 'permission' }), 'No, mejor no.') <= 200);
  assert.ok(turn(new AdaptiveEndpointer({ kind: 'ask', options: ['Supabase', 'Neon'] }), 'La segunda.') <= 200);
  assert.ok(turn(new AdaptiveEndpointer({ kind: 'ask', options: ['Supabase', 'Neon'] }), 'Neon.') <= 200);
});

test('adaptive: a complete sentence goes after a short natural pause', () => {
  const wait = turn(new AdaptiveEndpointer({ kind: 'stop' }), 'Cambia el endpoint de Supabase y despliega en Vercel.');
  assert.ok(wait >= 300 && wait <= 800, String(wait));
  const question = turn(new AdaptiveEndpointer({ kind: 'stop' }), '¿Has probado también el login?');
  assert.ok(question <= 600, String(question));
});

test('adaptive: unfinished thoughts wait (conjunctions, fillers, lists)', () => {
  for (const text of ['Haz eso y', 'Pues...', 'A ver,', 'Quiero que cambies la base de datos y', 'Eh', 'Primero el login, luego', 'Vale pues prueba Google y...']) {
    const wait = turn(new AdaptiveEndpointer({ kind: 'stop' }), text);
    assert.ok(wait >= 2500, `${text}: ${wait}`);
  }
});

test('adaptive: never sooner than a minimum silence after the voice ends', () => {
  const p = new AdaptiveEndpointer({ kind: 'permission' });
  p.speechStart(0);
  p.speechEnd(1000);
  p.final(1050, 'Sí.'); // transcript unusually fast
  assert.ok(p.deadline - 1000 >= 300);
});

test('adaptive: speaking again cancels; low confidence adds nothing; take() resets', () => {
  const p = new AdaptiveEndpointer({ kind: 'stop' });
  p.speechStart(0);
  p.speechEnd(1000);
  p.final(1500, 'Haz el cambio.');
  p.speechStart(1700);
  assert.equal(p.deadline, null);
  p.speechEnd(2600);
  p.final(2900, 'Orlando', 0.1);
  p.final(3000, 'en la base de datos.');
  assert.equal(p.take(), 'Haz el cambio. en la base de datos.');
  assert.equal(p.deadline, null);
});

test('Whisper\'s "C." for a lone "sí" is read as "Sí."', () => {
  assert.equal(fixShortAnswer('C.'), 'Sí.');
  assert.equal(fixShortAnswer('Sí.'), 'Sí.');
  assert.equal(fixShortAnswer('C. Vale.'), 'C. Vale.');
});

test('adaptive: never decides while the transcript of a phrase that just ended is still on its way', () => {
  const p = new AdaptiveEndpointer({ kind: 'stop' });
  p.speechStart(0);
  p.speechEnd(1000);
  p.final(2000, 'Vale pues prueba Google it.'); // Whisper heard "y" as "it."
  p.speechStart(1800); // …but the user was already saying "un momento"
  p.speechEnd(2600);
  assert.equal(p.deadline > 2600 + 4000, true, 'waits for the new transcript, with a safety cap');
  p.final(3900, 'un momento...');
  assert.ok(p.deadline - 3900 >= 2500, 'and "un momento…" keeps waiting');
});

test('adaptive: a phrase too short to transcribe (or rejected) does not block the turn', () => {
  const p = new AdaptiveEndpointer({ kind: 'stop' });
  p.speechStart(0);
  p.speechEnd(1000);
  p.final(1600, 'Haz el cambio.');
  p.speechStart(1700);
  p.speechEnd(2100, { expectFinal: false }); // 0.2 s of voice: the worker sends no transcript
  assert.ok(p.deadline - 2100 <= 600);
  p.speechStart(2300);
  p.speechEnd(3000);
  p.final(3500, '', 0); // rejected: no words
  assert.ok(p.deadline - 3500 <= 600);
});
