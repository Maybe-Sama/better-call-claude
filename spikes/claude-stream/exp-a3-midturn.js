// A3: a user message written while Claude is mid-turn — injected into the current turn or queued?
//   node exp-a3-midturn.js [reps=3] [cases=bash-default,bash-now,bash-next,text-default,text-now] [resultName=a3-midturn]
//   A3_TEXT_ITEMS=200 makes the text case long enough that the message lands well before the turn ends.
// Every case runs in one warm process with --replay-user-messages and uuid-stamped messages.
'use strict';
const { ClaudeStreamClient, sleep, saveResult } = require('./lib/client');

const WORDS = ['ZEBRA', 'OTTER', 'MAPLE', 'COBALT', 'TULIP', 'RAVEN'];
const PROMPTS = {
  bash: 'Use the Bash tool to run exactly this command: sleep 8\nAfter it finishes, reply with one short sentence saying it finished.',
  text: `Write a numbered list of ${process.env.A3_TEXT_ITEMS || 60} different animals, one per line, nothing else. Do not use any tools.`,
};

const assistantText = ev => ev.type === 'assistant' ? ev.message.content.filter(b => b.type === 'text').map(b => b.text).join('') : '';

async function rep(c, kind, priority, word) {
  const from = c.events.length;
  const t0 = c.sendUser(PROMPTS[kind], { uuid: true });
  const origUuid = c.writes[c.writes.length - 1].obj.uuid;
  // Trigger point: Bash tool_use emitted (bash) or first text delta (text).
  const trigger = kind === 'bash'
    ? await c.waitFor(ev => ev.type === 'assistant' && ev.message.content.some(b => b.type === 'tool_use'), { from, timeoutMs: 60000 })
    : await c.waitFor(ev => ev.type === 'stream_event' && ev.event.delta && ev.event.delta.type === 'text_delta', { from, timeoutMs: 60000 });
  await sleep(kind === 'bash' ? 1500 : 800);
  const extra = { uuid: true };
  if (priority) extra.priority = priority;
  const injText = kind === 'bash'
    ? `Additional instruction from the user: your reply must include the word ${word}.`
    : `Additional instruction from the user: after you finish, also write the word ${word}.`;
  const tInj = c.sendUser(injText, extra);
  const injUuid = c.writes[c.writes.length - 1].obj.uuid;
  const r1 = await c.waitFor(ev => ev.type === 'result', { from, timeoutMs: 120000 });
  const r1idx = c.events.indexOf(r1);
  // A queued message runs as its own turn: wait for a second result (or 25 s of nothing).
  const r2 = await c.waitFor(ev => ev.type === 'result', { from: r1idx + 1, timeoutMs: 25000 });
  const end = r2 ? c.events.indexOf(r2) + 1 : c.events.length;
  const span = c.events.slice(from, end);
  const before = c.events.slice(from, r1idx + 1);
  const textBeforeR1 = before.map(r => assistantText(r.ev)).join('');
  const textAfterR1 = c.events.slice(r1idx + 1, end).map(r => assistantText(r.ev)).join('');
  const lifecycle = span.filter(r => r.ev.type === 'system' && r.ev.subtype === 'command_lifecycle' || r.ev.type === 'command_lifecycle')
    .map(r => ({ t: +(r.t - tInj).toFixed(1), who: r.ev.command_uuid === injUuid ? 'injected' : r.ev.command_uuid === origUuid ? 'original' : 'other', state: r.ev.state }));
  const replays = span.filter(r => r.ev.type === 'user' && r.ev.isReplay)
    .map(r => ({ t: +(r.t - tInj).toFixed(1), who: r.ev.uuid === injUuid ? 'injected' : r.ev.uuid === origUuid ? 'original' : 'other', keys: Object.keys(r.ev) }));
  // Where (if anywhere) the injected text shows up as a user-side event in the current turn.
  const userEvents = before.filter(r => r.ev.type === 'user' && !r.ev.isReplay)
    .map(r => ({ t: +(r.t - tInj).toFixed(1), label: r.label, mentionsWord: JSON.stringify(r.ev.message).includes(word) }));
  const toolResult = before.find(r => r.ev.type === 'user' && JSON.stringify(r.ev.message).includes('tool_result'));
  const verdict = textBeforeR1.includes(word) ? 'injected-into-current-turn' : textAfterR1.includes(word) ? 'queued-as-next-turn' : 'not-seen';
  return {
    kind, priority: priority || 'default', word, verdict,
    triggerAt: trigger ? +(trigger.t - t0).toFixed(1) : null,
    injectAfterTrigger: trigger ? +(tInj - trigger.t).toFixed(1) : null,
    result1: { t: +(r1.t - tInj).toFixed(1), subtype: r1.ev.subtype, terminal_reason: r1.ev.terminal_reason, num_turns: r1.ev.num_turns, queued_turn_count: r1.ev.queued_turn_count, result_index: r1.ev.result_index },
    result2: r2 ? { t: +(r2.t - tInj).toFixed(1), subtype: r2.ev.subtype, terminal_reason: r2.ev.terminal_reason, queued_turn_count: r2.ev.queued_turn_count, result_index: r2.ev.result_index } : null,
    toolResultAt: toolResult ? +(toolResult.t - tInj).toFixed(1) : null,
    lifecycle, replays, userEvents,
    textBeforeR1: textBeforeR1.slice(-160), textAfterR1: textAfterR1.slice(0, 160),
    sequence: c.sequence({ from }).map(s => `${(s.t - tInj).toFixed(0)} ${s.label}${s.n ? ' x' + s.n : ''}`),
  };
}

async function main() {
  const reps = +(process.argv[2] || 3);
  const cases = (process.argv[3] || 'bash-default,bash-now,bash-next,text-default,text-now').split(',');
  const runs = [];
  for (const cs of cases) {
    const [kind, prio] = cs.split('-');
    const c = new ClaudeStreamClient({ model: 'haiku', replay: true, maxTurns: 6, extraArgs: ['--allowedTools', 'Bash(sleep *)'] }).start();
    for (let i = 0; i < reps; i++) {
      const r = await rep(c, kind, prio === 'default' ? null : prio, WORDS[i % WORDS.length]);
      console.log(cs, i, r.verdict, 'r1', JSON.stringify(r.result1), 'r2', JSON.stringify(r.result2), 'lifecycle', JSON.stringify(r.lifecycle), 'replays', r.replays.map(x => `${x.who}@${x.t}`).join(','));
      runs.push(r);
      await sleep(1500);
    }
    c.dumpRaw(`a3-${cs}`);
    await c.kill();
  }
  const byCase = {};
  for (const r of runs) {
    const k = `${r.kind}-${r.priority}`;
    byCase[k] = byCase[k] || {};
    byCase[k][r.verdict] = (byCase[k][r.verdict] || 0) + 1;
  }
  console.log(JSON.stringify(byCase));
  console.log('saved', saveResult(process.argv[4] || 'a3-midturn', { textItems: +(process.env.A3_TEXT_ITEMS || 60), byCase, runs }));
}
main().catch(e => { console.error(e); process.exit(1); });
