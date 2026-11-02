// A4: control_request interrupt — shape, latency, reliability; text streaming, long Bash, races.
//   node exp-a4-interrupt.js [reps=10] [cases=text,bash,race,cold,idle]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ClaudeStreamClient, sleep, stats, saveResult, SPIKE_CWD } = require('./lib/client');
const proc = require('./lib/proc');

const INTERRUPT = { subtype: 'interrupt' };
const isTextDelta = ev => ev.type === 'stream_event' && ev.event.delta && ev.event.delta.type === 'text_delta';
const assistantText = ev => ev.type === 'assistant' ? ev.message.content.filter(b => b.type === 'text').map(b => b.text).join('') : '';

// Interrupt now; measure control_response, result and trailing output.
async function interruptAndMeasure(c, from) {
  const ctl = c.control(INTERRUPT);
  const idx = c.events.length;
  const resp = await ctl.response;
  const res = await c.waitFor(ev => ev.type === 'result', { from, timeoutMs: 60000 });
  const after = c.events.slice(idx, res ? c.events.indexOf(res) : c.events.length);
  const lastStream = [...after].reverse().find(r => r.ev.type === 'stream_event');
  return {
    toControlResponse: resp ? +(resp.t - ctl.t).toFixed(1) : null,
    controlResponse: resp ? resp.ev.response : null,
    toResult: res ? +(res.t - ctl.t).toFixed(1) : null,
    toLastStreamEvent: lastStream ? +(lastStream.t - ctl.t).toFixed(1) : null,
    textDeltasAfterInterrupt: after.filter(r => isTextDelta(r.ev)).length,
    result: res ? { subtype: res.ev.subtype, is_error: res.ev.is_error, terminal_reason: res.ev.terminal_reason, stop_reason: res.ev.stop_reason, num_turns: res.ev.num_turns, text: String(res.ev.result || '').slice(0, 60) } : null,
    labelsAfterInterrupt: c.sequence({ from: idx }).slice(0, 14).map(s => `${(s.t - ctl.t).toFixed(0)} ${s.label}${s.n ? ' x' + s.n : ''}`),
    resIdx: res ? c.events.indexOf(res) : null,
  };
}

async function ask(c, text) {
  const from = c.events.length;
  const tw = c.sendUser(text);
  const res = await c.waitFor(ev => ev.type === 'result', { from, timeoutMs: 90000 });
  return { text: res ? String(res.ev.result).slice(0, 200) : null, subtype: res && res.ev.subtype, terminal_reason: res && res.ev.terminal_reason, toResult: res ? +(res.t - tw).toFixed(1) : null };
}

async function caseText(reps) {
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 3 }).start();
  const runs = [];
  for (let i = 0; i < reps; i++) {
    const from = c.events.length;
    c.sendUser(`Write a numbered list of 200 different animals, one per line, nothing else. Do not use tools. (run ${i})`);
    const first = await c.waitFor(isTextDelta, { from, timeoutMs: 60000 });
    await sleep(500);
    const m = await interruptAndMeasure(c, from);
    m.rep = i; m.firstDeltaFound = Boolean(first);
    runs.push(m);
    console.log('text', i, m.toControlResponse, m.toResult, m.toLastStreamEvent, JSON.stringify(m.result));
    await sleep(500);
  }
  const awareness = await ask(c, 'Was your previous answer interrupted by me before you finished? Reply YES or NO, then say in at most eight words what you were writing.');
  console.log('awareness', JSON.stringify(awareness));
  c.dumpRaw('a4-text');
  await c.kill();
  return { runs, awareness };
}

async function caseBash(reps) {
  // Scratch repo only: skip permission prompts so `sleep … && echo > marker` runs without asking.
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 3, extraArgs: ['--dangerously-skip-permissions'] }).start();
  const runs = [];
  const markers = [];
  for (let i = 0; i < reps; i++) {
    const marker = `marker-${Date.now()}-${i}.txt`;
    markers.push(marker);
    const from = c.events.length;
    c.sendUser(`Use the Bash tool to run exactly this command: sleep 21.37 && echo done > ${marker}\nThen reply OK.`);
    const tu = await c.waitFor(ev => ev.type === 'assistant' && ev.message.content.some(b => b.type === 'tool_use'), { from, timeoutMs: 60000 });
    // Wait until the shell is running (task_started) and a bit more.
    const ts = await c.waitFor(ev => ev.type === 'system' && ev.subtype === 'task_started', { from, timeoutMs: 15000 });
    await sleep(1500);
    const before = proc.findByCommandLine('21.37');
    const m = await interruptAndMeasure(c, from);
    await sleep(1000);
    const afterProcs = proc.findByCommandLine('21.37');
    const tr = c.events.slice(from, m.resIdx == null ? undefined : m.resIdx + 1).find(r => r.ev.type === 'user' && JSON.stringify(r.ev.message).includes('tool_result'));
    Object.assign(m, {
      rep: i, toolUseSeen: Boolean(tu), taskStartedSeen: Boolean(ts),
      sleepProcsBefore: before.map(p => p.Name), sleepProcsAfter: afterProcs.map(p => p.Name),
      toolResult: tr ? { content: JSON.stringify(tr.ev.message.content[0].content).slice(0, 120), is_error: tr.ev.message.content[0].is_error, interrupted: tr.ev.tool_use_result && tr.ev.tool_use_result.interrupted } : null,
    });
    runs.push(m);
    console.log('bash', i, m.toControlResponse, m.toResult, JSON.stringify(m.result), 'procs before/after', m.sleepProcsBefore.length, m.sleepProcsAfter.length, JSON.stringify(m.toolResult));
    await sleep(500);
  }
  const awareness = await ask(c, 'Did the last command you ran finish, or was it interrupted? Reply FINISHED or INTERRUPTED and nothing else.');
  console.log('awareness', JSON.stringify(awareness));
  c.dumpRaw('a4-bash');
  await c.kill();
  // A killed `sleep 21.37 && echo` never writes its marker.
  await sleep(23000);
  const markersWritten = markers.filter(m => fs.existsSync(path.join(SPIKE_CWD, m)));
  return { runs, awareness, markersWritten, markers: markers.length };
}

// Interrupt d ms after the message write, in a warm process; then check the session still answers.
async function caseRace(reps) {
  const delays = [0, 0, 50, 50, 150, 150, 400, 400, 1000, 1000, 2000, 2000].slice(0, reps);
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 3 }).start();
  await ask(c, 'Reply with exactly: READY');
  const runs = [];
  for (let i = 0; i < delays.length; i++) {
    const from = c.events.length;
    const tw = c.sendUser(`Reply with exactly: PING${i}`);
    await sleep(delays[i]);
    const m = await interruptAndMeasure(c, from);
    m.rep = i; m.delay = delays[i]; m.writeToInterrupt = +(c.writes[c.writes.length - 1].t - tw).toFixed(1);
    const extraResults = await c.waitFor(ev => ev.type === 'result', { from: m.resIdx + 1, timeoutMs: 3000 });
    m.extraResultWithin3s = extraResults ? { subtype: extraResults.ev.subtype, terminal_reason: extraResults.ev.terminal_reason, text: extraResults.ev.result } : null;
    const next = await ask(c, `Reply with exactly: PONG${i}`);
    m.next = next;
    m.usable = next.text === `PONG${i}`;
    runs.push(m);
    console.log('race', i, 'delay', delays[i], 'ctl', m.toControlResponse, 'res', m.toResult, JSON.stringify(m.result), 'next', JSON.stringify(next));
  }
  c.dumpRaw('a4-race');
  await c.kill();
  return { runs };
}

// Fresh process: interrupt immediately after the FIRST message (prewait window), then a second message.
async function caseCold(reps) {
  const runs = [];
  for (let i = 0; i < reps; i++) {
    const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 3 }).start();
    const tw = c.sendUser('Reply with exactly: FIRST');
    const m = await interruptAndMeasure(c, 0);
    m.rep = i; m.writeToInterrupt = +(c.writes[1].t - tw).toFixed(1);
    const next = await ask(c, 'Reply with exactly: SECOND');
    m.next = next;
    m.usable = next.text === 'SECOND';
    m.resultsSeen = c.events.filter(r => r.ev.type === 'result').map(r => `${r.ev.subtype}/${r.ev.terminal_reason}/${String(r.ev.result).slice(0, 20)}`);
    runs.push(m);
    console.log('cold', i, 'ctl', m.toControlResponse, 'res', m.toResult, JSON.stringify(m.result), 'next', JSON.stringify(next), m.resultsSeen.join(' ; '));
    c.dumpRaw(`a4-cold-${i}`);
    await c.kill();
  }
  return { runs };
}

// Interrupt while idle (after a finished turn), then a normal message.
async function caseIdle(reps) {
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 3 }).start();
  await ask(c, 'Reply with exactly: READY');
  const runs = [];
  for (let i = 0; i < reps; i++) {
    const ctl = c.control(INTERRUPT);
    const resp = await ctl.response;
    await sleep(300);
    const next = await ask(c, `Reply with exactly: IDLE${i}`);
    runs.push({ rep: i, toControlResponse: resp ? +(resp.t - ctl.t).toFixed(1) : null, controlResponse: resp && resp.ev.response, next, usable: next.text === `IDLE${i}` });
    console.log('idle', i, JSON.stringify(runs[i]));
  }
  await c.kill();
  return { runs };
}

async function main() {
  const reps = +(process.argv[2] || 10);
  const cases = (process.argv[3] || 'text,bash,race,cold,idle').split(',');
  const out = {};
  if (cases.includes('text')) out.text = await caseText(reps);
  if (cases.includes('bash')) out.bash = await caseBash(reps);
  if (cases.includes('race')) out.race = await caseRace(reps);
  if (cases.includes('cold')) out.cold = await caseCold(Math.min(reps, 3));
  if (cases.includes('idle')) out.idle = await caseIdle(Math.min(reps, 2));
  const summary = {};
  for (const [k, v] of Object.entries(out)) {
    const rs = v.runs;
    summary[k] = {
      reps: rs.length,
      toControlResponse: stats(rs.map(r => r.toControlResponse)),
      toResult: stats(rs.map(r => r.toResult)),
      toLastStreamEvent: stats(rs.map(r => r.toLastStreamEvent)),
      resultKinds: rs.reduce((a, r) => { const key = r.result ? `${r.result.subtype}/${r.result.terminal_reason}` : (r.next ? 'n/a' : 'no-result'); a[key] = (a[key] || 0) + 1; return a; }, {}),
      usableAfter: rs.filter(r => r.usable !== false).length,
    };
    if (v.markersWritten) summary[k].markersWritten = `${v.markersWritten.length}/${v.markers}`;
    if (k === 'bash') summary[k].sleepAliveAfter = rs.filter(r => r.sleepProcsAfter.length > 0).length;
    if (v.awareness) summary[k].awareness = v.awareness.text;
  }
  console.log(JSON.stringify(summary, null, 1));
  const name = process.argv[4] || `a4-interrupt-${cases.join('-')}`;
  console.log('saved', saveResult(name, { summary, ...out }));
}
main().catch(e => { console.error(e); process.exit(1); });
