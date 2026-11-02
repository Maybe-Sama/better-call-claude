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
