// B: hook-mode steering (for terminal sessions AgentCall cannot drive), tested with --settings hooks.
//   node exp-b-hooks.js [reps=3] [cases=b1,b2,stop-context,stop-block,batch-context,post-block,pre-context,rewake-midturn,rewake-idle,message-display]
'use strict';
const { ClaudeStreamClient, sleep, saveResult } = require('./lib/client');
const { writeSettings, readLog } = require('./lib/hooks');

const WORDS = ['QUASAR-9', 'NEBULA-4', 'PULSAR-2', 'COMET-6'];
const assistantText = ev => ev.type === 'assistant' ? ev.message.content.filter(b => b.type === 'text').map(b => b.text).join('') : '';

async function session(name, spec, prompt, { waitIdleMs = 0, allowed = 'Bash(echo *) Bash(sleep *)' } = {}) {
  const { file, log } = writeSettings(name, spec);
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 6, settings: file, extraArgs: ['--include-hook-events', '--allowedTools', allowed], env: { SPIKE_HOOK_LOG: log } }).start();
  const tw = c.sendUser(prompt);
  const r1 = await c.waitFor(ev => ev.type === 'result', { timeoutMs: 120000 });
  if (waitIdleMs) await c.waitFor(ev => ev.type === 'result' && ev !== (r1 && r1.ev), { from: c.events.indexOf(r1) + 1, timeoutMs: waitIdleMs });
  await sleep(300);
  const results = c.events.filter(r => r.ev.type === 'result');
  const hookEvents = c.events.filter(r => r.ev.type === 'system' && /^hook_/.test(r.ev.subtype) && r.ev.hook_event !== 'SessionStart' && !(r.ev.hook_name || '').startsWith('SessionStart'));
  const probe = readLog(log, c.wall0);
  // Merged timeline (ms since spawn): stream events of interest + probe hook calls.
  const timeline = [
    ...c.events.filter(r => ['assistant', 'user', 'result'].includes(r.ev.type) || hookEvents.includes(r) || (r.ev.type === 'system' && /^task_/.test(r.ev.subtype)))
      .map(r => ({ t: +r.t.toFixed(0), what: r.ev.type === 'system' ? `${r.ev.subtype}:${r.ev.hook_name || r.ev.task_id || ''}` : r.label + (r.ev.type === 'assistant' && assistantText(r.ev) ? ` "${assistantText(r.ev).slice(0, 70)}"` : '') + (r.ev.type === 'user' && !JSON.stringify(r.ev.message).includes('tool_result') ? ` "${JSON.stringify(r.ev.message.content).slice(0, 120)}"` : '') })),
    ...probe.map(p => ({ t: p.tRel, what: `probe:${p.mode}:${p.event || ''}${p.tool ? ':' + p.tool : ''}` })),
  ].sort((a, b) => a.t - b.t);
  const out = {
    name,
    results: results.map(r => ({ t: +(r.t - tw).toFixed(0), subtype: r.ev.subtype, terminal_reason: r.ev.terminal_reason, num_turns: r.ev.num_turns, text: String(r.ev.result).slice(0, 200) })),
    allAssistantText: c.events.map(r => assistantText(r.ev)).filter(Boolean).join(' || ').slice(0, 600),
    toolUses: c.events.filter(r => r.ev.type === 'assistant').flatMap(r => r.ev.message.content.filter(b => b.type === 'tool_use').map(b => b.input.command || b.name)),
    toolResults: c.events.filter(r => r.ev.type === 'user' && Array.isArray(r.ev.message.content) && r.ev.message.content[0] && r.ev.message.content[0].type === 'tool_result').map(r => ({ is_error: r.ev.message.content[0].is_error, content: JSON.stringify(r.ev.message.content[0].content).slice(0, 200) })),
    hookResponses: hookEvents.filter(r => r.ev.subtype === 'hook_response').map(r => ({ name: r.ev.hook_name, outcome: r.ev.outcome, exit_code: r.ev.exit_code, output: String(r.ev.output || '').slice(0, 160) })),
    probeCalls: probe.length,
    timeline,
  };
  c.dumpRaw(`b-${name}`);
  await c.kill();
  return out;
}

const CASES = {
  async b1(i) {
    const w = WORDS[i % WORDS.length];
    const r = await session(`b1-${i}`, { PostToolUse: [{ matcher: 'Bash', mode: 'post-context', text: `Voice message from the user: the secret word is ${w}. Include it in your final reply.` }] },
      'Use the Bash tool to run exactly this command: echo hello\nThen reply with the command output. If you were given a secret word at any point, include it; otherwise write NO-SECRET.');
    return { ...r, word: w, seen: r.allAssistantText.includes(w) };
  },
  async b2(i) {
    const r = await session(`b2-${i}`, { PreToolUse: [{ matcher: 'Bash', mode: 'pre-deny', text: 'The user interrupted by voice: stop and ask what they want.' }] },
      'Use the Bash tool to run exactly this command: echo one\nThen use the Bash tool to run exactly: echo two\nThen reply DONE.');
    return { ...r, bashAttempts: r.toolUses.length, asksUser: /\?/.test(r.allAssistantText) };
  },
  async 'stop-context'(i) {
    const w = WORDS[i % WORDS.length];
    const r = await session(`stop-context-${i}`, { Stop: [{ mode: 'stop-context', text: `Voice message from the user: also say the word ${w}.` }] }, 'Reply with exactly: FIRST-ANSWER');
    return { ...r, word: w, seen: r.allAssistantText.includes(w) };
  },
  async 'stop-block'(i) {
    const w = WORDS[i % WORDS.length];
    const r = await session(`stop-block-${i}`, { Stop: [{ mode: 'stop-block', text: `Voice message from the user: also say the word ${w}.` }] }, 'Reply with exactly: FIRST-ANSWER');
    return { ...r, word: w, seen: r.allAssistantText.includes(w) };
  },
  async 'batch-context'(i) {
    const w = WORDS[i % WORDS.length];
    const r = await session(`batch-context-${i}`, { PostToolBatch: [{ mode: 'batch-context', text: `Voice message from the user: the secret word is ${w}. Include it in your final reply.` }] },
      'Use the Bash tool to run exactly this command: echo hello\nThen reply with the command output. If you were given a secret word at any point, include it; otherwise write NO-SECRET.');
    return { ...r, word: w, seen: r.allAssistantText.includes(w) };
  },
  async 'post-block'(i) {
    const w = WORDS[i % WORDS.length];
    const r = await session(`post-block-${i}`, { PostToolUse: [{ matcher: 'Bash', mode: 'post-block', text: `Voice message from the user: the secret word is ${w}. Include it in your final reply.` }] },
      'Use the Bash tool to run exactly this command: echo hello\nThen reply with the command output. If you were given a secret word at any point, include it; otherwise write NO-SECRET.');
    return { ...r, word: w, seen: r.allAssistantText.includes(w) };
  },
  async 'pre-context'(i) {
    const w = WORDS[i % WORDS.length];
    const r = await session(`pre-context-${i}`, { PreToolUse: [{ matcher: 'Bash', mode: 'pre-context', text: `Voice message from the user: the secret word is ${w}. Include it in your final reply.` }] },
      'Use the Bash tool to run exactly this command: echo hello\nThen reply with the command output. If you were given a secret word at any point, include it; otherwise write NO-SECRET.');
    return { ...r, word: w, seen: r.allAssistantText.includes(w) };
  },
  // asyncRewake hook started by UserPromptSubmit fires (exit 2) while a Bash sleep is running.
  async 'rewake-midturn'(i) {
    const w = WORDS[i % WORDS.length];
    const r = await session(`rewake-midturn-${i}`, { UserPromptSubmit: [{ mode: 'rewake', text: '4000', extra: [`Voice message from the user: also say the word ${w}.`], asyncRewake: true, timeout: 60 }] },
      'Use the Bash tool to run exactly this command: sleep 10\nThen reply with exactly: DONE', { waitIdleMs: 20000 });
    return { ...r, word: w, seen: r.allAssistantText.includes(w) };
  },
  // asyncRewake hook fires after the turn already ended (session idle, process alive).
  async 'rewake-idle'(i) {
    const w = WORDS[i % WORDS.length];
    const r = await session(`rewake-idle-${i}`, { UserPromptSubmit: [{ mode: 'rewake', text: '9000', extra: [`Voice message from the user: also say the word ${w}.`], asyncRewake: true, timeout: 60 }] },
      'Reply with exactly: QUICK', { waitIdleMs: 25000 });
    return { ...r, word: w, seen: r.allAssistantText.includes(w) };
  },
  async 'message-display'(i) {
    const r = await session(`message-display-${i}`, { MessageDisplay: [{ mode: 'log' }] }, 'Write five short lines about lighthouses, one per line.');
    return r;
  },
};

async function main() {
  const reps = +(process.argv[2] || 3);
  const names = (process.argv[3] || Object.keys(CASES).join(',')).split(',');
  const out = {};
  for (const n of names) {
    const k = ['b1', 'b2'].includes(n) ? reps : Math.min(reps, n.startsWith('rewake') || n.startsWith('stop') ? 2 : 1);
    out[n] = [];
    for (let i = 0; i < k; i++) {
      const r = await CASES[n](i);
      out[n].push(r);
      console.log(n, i, 'seen', r.seen, 'results', JSON.stringify(r.results), 'tools', JSON.stringify(r.toolUses), 'probeCalls', r.probeCalls);
      console.log('   text:', r.allAssistantText.slice(0, 300));
    }
  }
  console.log('saved', saveResult(process.argv[4] || 'b-hooks', out));
}
main().catch(e => { console.error(e); process.exit(1); });
