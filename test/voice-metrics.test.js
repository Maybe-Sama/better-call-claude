const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceMetrics, percentile, FAILURES } = require('../src/voice/metrics');

test('percentile: nearest-rank over finite values', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 6);
  assert.equal(percentile([10, NaN, 1, Infinity, 3], 90), 10);
});

test('summary per metric and failure counters', () => {
  const m = new VoiceMetrics({ now: () => 1 });
  for (const ms of [100, 200, 300]) m.record('bargein.stop_ms', ms);
  m.fail('speech_lost');
  m.fail('speech_lost');
  const s = m.summary();
  assert.deepEqual(s.metrics['bargein.stop_ms'], { count: 3, p50: 200, p90: 300, max: 300 });
  assert.equal(s.failures.speech_lost, 2);
  assert.ok(FAILURES.includes('premature_endpoint'));
  assert.throws(() => m.fail('made_up'), /unknown failure/);
});

test('never stores or writes what the user or Claude said', () => {
  const lines = [];
  const m = new VoiceMetrics({ now: () => 7, sink: line => lines.push(line) });
  m.record('turn.endpoint_ms', 640, { text: 'mi contraseña es 1234', transcript: 'secreto', kind: 'stop', route: 'answer', chars: 21 });
  m.record('stt.final_ms', 900, { kind: 'quiero que borres todo el repositorio ahora mismo por favor' });
  const all = JSON.stringify(m.entries()) + lines.join('\n');
  assert.doesNotMatch(all, /contraseña|1234|secreto|borres/);
  assert.match(lines[0], /"route":"answer"/);
  assert.match(lines[0], /"chars":21/);
});

test('keeps only the newest entries', () => {
  const m = new VoiceMetrics({ capacity: 3 });
  for (let i = 0; i < 5; i += 1) m.record('x', i);
  assert.deepEqual(m.entries().map(e => e.ms), [2, 3, 4]);
});

test('a failing sink never breaks the call', () => {
  const m = new VoiceMetrics({ sink: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => m.record('x', 1));
});
