// A5: partial-message streaming — first text_delta latency, delta cadence, telling text apart from
// tool input / thinking deltas.
//   node exp-a5-streaming.js [reps=3] [model=haiku]
'use strict';
const { ClaudeStreamClient, stats, saveResult } = require('./lib/client');

async function rep(c, i) {
  const from = c.events.length;
  const tw = c.sendUser(`Use the Bash tool to run exactly this command: echo hi-${i}\nThen write about 150 words about lighthouses as plain prose.`);
  const res = await c.waitFor(ev => ev.type === 'result', { from, timeoutMs: 120000 });
  const evs = c.events.slice(from);
  // content_block_start tells which kind each index is, per API message (message_start resets indexes).
  let kinds = {};
  const deltas = [];
  for (const r of evs) {
    if (r.ev.type !== 'stream_event') continue;
    const e = r.ev.event;
    if (e.type === 'message_start') kinds = {};
    if (e.type === 'content_block_start') kinds[e.index] = e.content_block.type;
    if (e.type === 'content_block_delta') deltas.push({ t: r.t, blockKind: kinds[e.index], deltaType: e.delta.type, chars: (e.delta.text || e.delta.partial_json || e.delta.thinking || '').length, sub: Boolean(r.ev.parent_tool_use_id) });
  }
  const text = deltas.filter(d => d.deltaType === 'text_delta');
  const gaps = text.slice(1).map((d, k) => d.t - text[k].t);
  const byPair = {};
  for (const d of deltas) { const k = `${d.blockKind}/${d.deltaType}`; byPair[k] = (byPair[k] || 0) + 1; }
  const assistantEvents = evs.filter(r => r.ev.type === 'assistant').map(r => ({ id: r.ev.message.id, blocks: r.ev.message.content.map(b => b.type) }));
  return {
    rep: i,
    writeToFirstStreamEvent: +((evs.find(r => r.ev.type === 'stream_event') || {}).t - tw).toFixed(1),
    writeToFirstTextDelta: text.length ? +(text[0].t - tw).toFixed(1) : null,
    writeToResult: res ? +(res.t - tw).toFixed(1) : null,
    textDeltas: text.length,
    textChars: text.reduce((a, d) => a + d.chars, 0),
    charsPerDelta: stats(text.map(d => d.chars)),
    gapMs: stats(gaps),
    gapP90: gaps.length ? +[...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * 0.9)].toFixed(1) : null,
    blockKindDeltaPairs: byPair,
    assistantEvents,
    sequence: c.sequence({ from }).map(s => s.label + (s.n ? ' x' + s.n : '')),
  };
}

async function main() {
  const reps = +(process.argv[2] || 3);
  const model = process.argv[3] || 'haiku';
  const c = new ClaudeStreamClient({ model, maxTurns: 4, extraArgs: ['--allowedTools', 'Bash(echo *)'] }).start();
  const runs = [];
  for (let i = 0; i < reps; i++) {
    const r = await rep(c, i);
    runs.push(r);
    console.log(i, 'firstText', r.writeToFirstTextDelta, 'deltas', r.textDeltas, 'chars/delta', JSON.stringify(r.charsPerDelta), 'gap', JSON.stringify(r.gapMs), 'p90', r.gapP90, JSON.stringify(r.blockKindDeltaPairs));
  }
  c.dumpRaw(`a5-${model}`);
  await c.kill();
  const summary = {
    model,
    writeToFirstTextDelta: stats(runs.map(r => r.writeToFirstTextDelta)),
    gapMedianPerRep: runs.map(r => r.gapMs.median), gapMaxPerRep: runs.map(r => r.gapMs.max), gapP90PerRep: runs.map(r => r.gapP90),
    charsPerDeltaMedianPerRep: runs.map(r => r.charsPerDelta.median),
  };
  console.log(JSON.stringify(summary));
  console.log('saved', saveResult(`a5-streaming-${model}`, { summary, runs }));
}
main().catch(e => { console.error(e); process.exit(1); });
