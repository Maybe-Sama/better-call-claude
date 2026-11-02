// A9: lifecycle — stdin close (idle / mid-turn), kill mid-tool (orphans?), idle memory/CPU, long idle.
//   node exp-a9-lifecycle.js [idleSeconds=240] [cases=close-idle,close-midturn,kill-midtool,idle]
'use strict';
const { ClaudeStreamClient, sleep, saveResult } = require('./lib/client');
const proc = require('./lib/proc');

async function ready(c, text = 'Reply with exactly: READY') {
  const from = c.events.length;
  const tw = c.sendUser(text);
  const r = await c.waitFor(ev => ev.type === 'result', { from, timeoutMs: 90000 });
  return { text: r && r.ev.result, t: r ? +(r.t - tw).toFixed(1) : null };
}

async function closeIdle() {
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 1 }).start();
  await ready(c);
  const tc = c.closeStdin();
  const ex = await c.exited;
  return { closeToExit: +(ex.t - tc).toFixed(1), exit: { code: ex.code, signal: ex.signal } };
}

async function closeMidTurn() {
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 3, extraArgs: ['--allowedTools', 'Bash(sleep *)'] }).start();
  c.sendUser('Use the Bash tool to run exactly this command: sleep 6\nThen reply with exactly: AFTER-SLEEP');
  await c.waitFor(ev => ev.type === 'assistant' && ev.message.content.some(b => b.type === 'tool_use'), { timeoutMs: 60000 });
  const tc = c.closeStdin();
  const ex = await c.exited;
  const res = c.events.find(r => r.ev.type === 'result');
  return { closeToExit: +(ex.t - tc).toFixed(1), exit: { code: ex.code, signal: ex.signal }, resultBeforeExit: res ? { subtype: res.ev.subtype, terminal_reason: res.ev.terminal_reason, text: res.ev.result, tAfterClose: +(res.t - tc).toFixed(1) } : null };
}

async function killMidTool() {
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 3, extraArgs: ['--allowedTools', 'Bash(sleep *)'] }).start();
  c.sendUser('Use the Bash tool to run exactly this command: sleep 33.21\nThen reply OK.');
  await c.waitFor(ev => ev.type === 'system' && ev.subtype === 'task_started', { timeoutMs: 60000 });
  await sleep(1000);
  const treeBefore = proc.tree(c.pid);
  const sleepBefore = proc.findByCommandLine('33.21');
  const tk = c.now();
  c.child.kill(); // TerminateProcess on Windows
  const ex = await c.exited;
  await sleep(1500);
  const sleepAfter = proc.findByCommandLine('33.21');
  const childPids = treeBefore.filter(p => p.pid !== c.pid).map(p => p.pid);
  const survivors = proc.alive(childPids);
  const out = {
    killToExit: +(ex.t - tk).toFixed(1), exit: { code: ex.code, signal: ex.signal },
    treeBefore: treeBefore.map(p => `${p.name}`),
    sleepBefore: sleepBefore.length, sleepAfter: sleepAfter.length,
    survivingChildren: survivors.map(p => p.ProcessName),
  };
  // Clean up only what this experiment started (the orphaned sleep and its shell, if any).
  for (const p of [...sleepAfter]) { try { process.kill(p.ProcessId); } catch { /* gone */ } }
  for (const p of survivors) { try { process.kill(p.Id); } catch { /* gone */ } }
  return out;
}

async function idle(seconds) {
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 1 }).start();
  const first = await ready(c);
  const samples = [];
  const evBefore = c.events.length;
  const t0 = c.now();
  for (let s = 0; ; s += 30) {
    const tr = proc.tree(c.pid);
    const self = tr.find(p => p.pid === c.pid) || {};
    samples.push({ s, claudeWsMB: self.wsMB, claudeCpuS: self.cpuS, treeWsMB: +tr.reduce((a, p) => a + (p.wsMB || 0), 0).toFixed(1), treeCpuS: +tr.reduce((a, p) => a + (p.cpuS || 0), 0).toFixed(2), procs: tr.length });
    if (s >= seconds) break;
    await sleep(30000);
  }
  const idleEvents = c.events.slice(evBefore).map(r => r.label);
  const after = await ready(c, 'Reply with exactly: AWAKE');
  const tree = proc.tree(c.pid).map(p => p.name);
  await c.kill();
  const cpuIdle = samples.length > 1 ? +(samples[samples.length - 1].claudeCpuS - samples[0].claudeCpuS).toFixed(2) : null;
  return { idleSeconds: +((c.now() - t0) / 1000).toFixed(0), first, samples, claudeCpuSecondsDuringIdle: cpuIdle, eventsWhileIdle: idleEvents, afterIdle: after, processTree: tree };
}

async function main() {
  const seconds = +(process.argv[2] || 240);
  const cases = (process.argv[3] || 'close-idle,close-midturn,kill-midtool,idle').split(',');
  const out = {};
  if (cases.includes('close-idle')) { out.closeIdle = await closeIdle(); console.log('close-idle', JSON.stringify(out.closeIdle)); }
  if (cases.includes('close-midturn')) { out.closeMidTurn = await closeMidTurn(); console.log('close-midturn', JSON.stringify(out.closeMidTurn)); }
  if (cases.includes('kill-midtool')) { out.killMidTool = await killMidTool(); console.log('kill-midtool', JSON.stringify(out.killMidTool)); }
  if (cases.includes('idle')) { out.idle = await idle(seconds); console.log('idle', JSON.stringify(out.idle)); }
  // Earlier partial runs: keep their cases, overwrite the ones re-run now.
  let prev = {};
  try { prev = require('./results/a9-lifecycle.json'); } catch { /* first run */ }
  const keep = Object.fromEntries(Object.entries(prev).filter(([k]) => ['closeIdle', 'closeMidTurn', 'killMidTool', 'idle'].includes(k)));
  console.log('saved', saveResult('a9-lifecycle', { ...keep, ...out }));
}
main().catch(e => { console.error(e); process.exit(1); });
