'use strict';
// Live check of src/voice/stream-session.js against the installed Claude Code (NOT part of npm test).
//   node scripts/stream-session-smoke.js [--keep] [--no-opus]
// Runs in a scratch git repo (E:\tmp\stream-session-smoke) with haiku and tiny prompts, then closes every
// session and removes the repo and its ~/.claude/projects transcript folder (unless --keep). --no-opus skips
// the one default-model run that reports which permission mode the user's real default gets.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { StreamSession } = require('../src/voice/stream-session');
const { SpeechChunker } = require('../src/voice/speech-chunker');

const CWD = 'E:\\tmp\\stream-session-smoke';
const KEEP = process.argv.includes('--keep');
const OPUS = !process.argv.includes('--no-opus');
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const log = (...a) => console.log(String(ms()).padStart(7), ...a);
const sleep = n => new Promise(r => setTimeout(r, n));
const summary = {};
const sessions = []; // every session opened, closed in finally

function ps(script) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
    return out ? [].concat(JSON.parse(out)) : [];
  } catch (err) {
    const out = String(err.stdout || '').trim(); // Get-Process exits 1 when some ids are gone, but prints the live ones
    try { return out ? [].concat(JSON.parse(out)) : []; } catch { return []; }
  }
}

// The process tree under pid (pid included), while its parents are alive.
function tree(pid) {
  return ps(`$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name
$ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add(${pid})
do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $added = $true } } } while ($added)
$all | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object ProcessId,Name | ConvertTo-Json -Compress`).map(p => ({ pid: p.ProcessId, name: p.Name }));
}

const alive = pids => (pids.length ? ps(`Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | ConvertTo-Json -Compress`).map(p => ({ pid: p.Id, name: p.ProcessName })) : []);
const sleeps = () => ps("Get-CimInstance Win32_Process -Filter \"Name='sleep.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress");
const namingSession = id => ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${id}*' -and $_.ProcessId -ne $PID } | Select-Object ProcessId,Name | ConvertTo-Json -Compress`);

function waitFor(session, event, pred = () => true, timeoutMs = 120000) {
  return new Promise(resolve => {
    const on = v => { if (pred(v)) { cleanupWait(); resolve(v ?? true); } };
    const timer = setTimeout(() => { cleanupWait(); resolve(null); }, timeoutMs);
    const cleanupWait = () => { clearTimeout(timer); session.off(event, on); };
    session.on(event, on);
  });
}

function setupRepo() {
  fs.mkdirSync(CWD, { recursive: true });
  if (!fs.existsSync(path.join(CWD, '.git'))) {
    execFileSync('git', ['init', '-q'], { cwd: CWD });
    fs.writeFileSync(path.join(CWD, 'README.md'), '# scratch\n');
    execFileSync('git', ['add', '.'], { cwd: CWD });
    execFileSync('git', ['-c', 'user.email=smoke@example.invalid', '-c', 'user.name=smoke', 'commit', '-qm', 'init'], { cwd: CWD });
  }
  for (const f of ['smoke.txt', 'opus.txt']) fs.rmSync(path.join(CWD, f), { force: true });
}

async function cleanup() {
  for (const s of sessions) await s.close().catch(() => {}); // a live claude.exe keeps the folder busy
  if (KEEP) { log('kept', CWD); return; }
  const rm = p => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (err) { log('could not remove', p, err.code); } };
  rm(CWD);
  const projects = path.join(os.homedir(), '.claude', 'projects');
  for (const d of fs.existsSync(projects) ? fs.readdirSync(projects) : []) if (d.startsWith('E--tmp-stream-session-smoke')) rm(path.join(projects, d));
  log('removed', CWD, 'and its transcript folder');
}

// Instrumented session: logs lifecycle/turns/permissions with times, records costs, tool results and writes.
function open(options) {
  const s = new StreamSession({ cwd: CWD, ...options });
  sessions.push(s);
  s.costs = [];
  s.toolResults = new Map();
  s.writes = [];
  s.on('raw', ev => {
    if (ev.type === 'result') s.costs.push(ev.total_cost_usd || 0);
    if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) if (b?.type === 'tool_result') s.toolResults.set(b.tool_use_id, { at: ms(), content: b.content });
    }
  });
  s.on('message', m => log(`  message ${m.uuid.slice(0, 8)} ${m.state}`));
  s.on('turn-start', () => log('  turn-start'));
  s.on('turn-end', e => log(`  turn-end ${e.terminalReason} aborted=${e.aborted} isError=${e.isError} result=${JSON.stringify(String(e.result).slice(0, 80))}`));
  s.on('tool', t => log(`  tool ${t.name}`));
  s.on('assistant-message', m => log(`  assistant-message aborted=${m.aborted} ${JSON.stringify(m.text.slice(0, 60))}`));
  s.on('error', err => log('  ERROR', err.message));
  s.on('exit', e => log('  exit', JSON.stringify(e)));
  s.policy = p => s.allow(p.requestId);
  s.on('permission', p => {
    log(`  permission ${p.toolName} ${JSON.stringify(p.description || '')} input=${JSON.stringify(p.input).slice(0, 120)}`);
    s.policy(p);
  });
  const start = s.start.bind(s);
  s.start = () => {
    const started = start();
    const stdin = s.child.stdin; // to show what send() really wrote
    const write = stdin.write.bind(stdin);
    stdin.write = (chunk, ...rest) => { s.writes.push(String(chunk)); return write(chunk, ...rest); };
    return started;
  };
  return s;
}

const written = (s, uuid) => s.writes.map(w => JSON.parse(w)).find(w => w.uuid === uuid);

// One turn: send, collect streamed text, spoken sentences and their timing, wait for the end. Speech uses
// one SpeechChunker per assistant message ('assistant-start'), as the speech rules are per message.
async function turn(s, text, { onText = null } = {}) {
  const sentAt = performance.now();
  const deltas = [];
  let chunker = new SpeechChunker();
  const sentences = [];
  const say = sentence => sentences.push({ t: Math.round(performance.now() - sentAt), at: ms(), sentence });
  const onStart = () => {
    const rest = chunker.finish();
    if (rest) say(rest);
    chunker = new SpeechChunker();
  };
  const onDelta = ({ delta }) => {
    deltas.push({ t: performance.now() - sentAt, delta });
    for (const sentence of chunker.push(delta)) say(sentence);
    if (onText) onText(deltas);
  };
  s.on('assistant-start', onStart);
  s.on('text', onDelta);
  const ended = waitFor(s, 'turn-end');
  const uuid = s.send(text);
  log(`> ${JSON.stringify(text.slice(0, 100))} (${uuid.slice(0, 8)})`);
  const end = await ended;
  s.off('text', onDelta);
  s.off('assistant-start', onStart);
  const rest = chunker.finish();
  const gaps = deltas.slice(1).map((d, i) => d.t - deltas[i].t).sort((a, b) => a - b);
  return {
    uuid, end,
    firstTextMs: deltas.length ? Math.round(deltas[0].t) : null,
    endMs: Math.round(performance.now() - sentAt),
    deltas: deltas.length,
    medianGapMs: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null,
    text: deltas.map(d => d.delta).join(''),
    sentences, rest,
  };
}

const LONG = 'Write the numbers from one to eighty in Spanish words, one per line, nothing else.';

async function main() {
  setupRepo();

  // 1. start
  const s = open({ model: 'haiku' });
  const tStart = performance.now();
  await s.start();
  summary.start = { readyMs: Math.round(performance.now() - tStart), pid: s.child.pid, sessionId: s.sessionId, capabilitiesBeforeFirstTurn: s.capabilities };
  log('1 ready', JSON.stringify(summary.start));

  // 2. a short prompt, streamed and chunked
  const t2 = await turn(s, 'Reply with exactly this sentence: Hola, soy Claude. Todo funciona bien.');
  summary.streamed = { model: s.model, permissionMode: s.permissionMode, capabilities: s.capabilities, version: s.claudeCodeVersion,
    firstTextMs: t2.firstTextMs, endMs: t2.endMs, deltas: t2.deltas, medianGapMs: t2.medianGapMs, text: t2.text,
    spokenSentences: t2.sentences.map(x => [x.t, x.sentence]), spokenRest: t2.rest, terminalReason: t2.end?.terminalReason };
  log('2 streamed', JSON.stringify(summary.streamed));

  // 3. the sentence before a tool is spoken before the tool runs; a message sent while Bash `sleep 5` runs
  {
    const states = [];
    const onMsg = m => states.push({ t: ms(), ...m });
    s.on('message', onMsg);
    let toolAt = null;
    let bashId = null;
    const onTool = t => { if (t.name === 'Bash' && !toolAt) { toolAt = ms(); bashId = t.toolUseId; } };
    s.on('tool', onTool);
    const bashStarted = waitFor(s, 'tool', t => t.name === 'Bash', 60000);
    let second = null;
    const r = turn(s, 'First say in one short sentence what you are going to do. Then use the Bash tool to run exactly this command: sleep 5\nThen reply with exactly: DONE');
    if (await bashStarted) {
      await sleep(2500); // past the permission answer, while sleep runs
      second = s.send('Also add the word PELICAN at the end of your final reply.');
      log(`> mid-turn PELICAN (${second.slice(0, 8)})`);
    }
    const t3 = await r;
    const ends = [t3.end];
    if (second && !states.some(x => x.uuid === second && x.state === 'completed')) ends.push(await waitFor(s, 'turn-end', () => true, 60000));
    s.off('message', onMsg);
    s.off('tool', onTool);
    const first = t3.uuid;
    const startedSecond = states.find(x => x.uuid === second && x.state === 'started');
    const completedFirst = states.find(x => x.uuid === first && x.state === 'completed');
    const beforeTool = t3.sentences.find(x => toolAt && x.at <= toolAt + 50);
    summary.toolBoundary = { sentenceBeforeTool: beforeTool?.sentence ?? null, spokenAt: beforeTool?.at ?? null, toolEventAt: toolAt, toolResultAt: s.toolResults.get(bashId)?.at ?? null,
      spokenAfterTool: t3.sentences.filter(x => toolAt && x.at > toolAt + 50).map(x => x.sentence).concat(t3.rest ? [t3.rest] : []) };
    summary.midTurn = {
      lifecycle: states.map(x => `${x.uuid === first ? 'first' : x.uuid === second ? 'second' : x.uuid.slice(0, 8)}:${x.state}`),
      folded: Boolean(startedSecond && (!completedFirst || startedSecond.t <= completedFirst.t)),
      turns: ends.length, results: ends.map(e => e?.result), pelican: /PELICAN/.test(ends.map(e => e?.result).join(' ')),
    };
    log('3 tool boundary', JSON.stringify(summary.toolBoundary));
    log('3 mid-turn', JSON.stringify(summary.midTurn));
  }

  // 4. priority "now" while Claude writes text (no tool, nothing queued)
  {
    const states = [];
    const onMsg = m => states.push(m);
    s.on('message', onMsg);
    const firstText = waitFor(s, 'text', () => true, 60000);
    const firstEnd = waitFor(s, 'turn-end');
    const a = s.send(LONG);
    await firstText;
    await sleep(800);
    const b = s.send('Stop that. Reply with exactly: AHORA', { priority: 'now' });
    log(`> priority now (${b.slice(0, 8)}) written with priority=${written(s, b)?.priority}`);
    const e1 = await firstEnd;
    const e2 = e1?.aborted ? await waitFor(s, 'turn-end') : null;
    await sleep(300); // late lifecycle events
    s.off('message', onMsg);
    summary.priorityNow = {
      writtenPriority: written(s, b)?.priority ?? null,
      lifecycle: states.map(x => `${x.uuid === a ? 'original' : x.uuid === b ? 'now' : '?'}:${x.state}`),
      firstTurn: e1 && { terminalReason: e1.terminalReason, isError: e1.isError },
      secondTurn: e2 && { terminalReason: e2.terminalReason, result: e2.result },
    };
    log('4 priority now', JSON.stringify(summary.priorityNow));
  }

  // 5. interrupt during a long answer
  {
    let interruptAt = 0;
    let receipt = null;
    let interrupted = null;
    const aborted = waitFor(s, 'assistant-message', m => m.aborted, 60000);
    const t5 = await turn(s, 'Count from one to one hundred in Spanish words, one per line, nothing else.', {
      onText: deltas => {
        if (interruptAt || deltas.map(d => d.delta).join('').length < 150) return;
        interruptAt = performance.now();
        interrupted = s.interrupt().then(r => { receipt = { ms: Math.round(performance.now() - interruptAt), response: r }; });
      },
    });
    const endMs = interruptAt ? Math.round(performance.now() - interruptAt) : null;
    if (interrupted) await Promise.race([interrupted, sleep(4000)]);
    const partial = await Promise.race([aborted, sleep(500).then(() => null)]);
    summary.interrupt = { receipt, interruptToTurnEndMs: endMs, terminalReason: t5.end?.terminalReason, isError: t5.end?.isError,
      abortedAssistantChars: partial ? partial.text.length : null };
    log('5 interrupt', JSON.stringify(summary.interrupt));
  }

  // 5b. sendUrgent during a long answer: interrupt → end of turn → the new message
  {
    const firstText = waitFor(s, 'text', () => true, 60000);
    const firstEnd = waitFor(s, 'turn-end');
    s.send(LONG);
    await firstText;
    await sleep(600);
    const tu = performance.now();
    const secondEnd = firstEnd.then(() => waitFor(s, 'turn-end'));
    const uuid = await s.sendUrgent('Reply with exactly: URGENTE');
    const sentMs = Math.round(performance.now() - tu);
    const e1 = await firstEnd;
    const e2 = await secondEnd;
    summary.sendUrgent = { uuid: uuid.slice(0, 8), sentAfterMs: sentMs, first: e1?.terminalReason, second: e2?.terminalReason, result: e2?.result };
    log('5b sendUrgent', JSON.stringify(summary.sendUrgent));
  }

  // 6. permission: deny, then allow
  {
    const file = path.join(CWD, 'smoke.txt');
    const asked = [];
    s.policy = p => { asked.push({ tool: p.toolName, description: p.description, toolUseId: p.toolUseId, input: Object.keys(p.input) }); s.deny(p.requestId, 'The user declined this by voice. Do not retry. Reply exactly: DENIED'); };
    const d = await turn(s, 'Use the Write tool to create a file named smoke.txt containing the word hi. Use no other tool.');
    const afterDeny = fs.existsSync(file);
    s.policy = p => { asked.push({ tool: p.toolName, allowed: s.allow(p.requestId) }); };
    const a = await turn(s, 'The user changed their mind: create smoke.txt now with the Write tool, it will be approved. Then reply exactly: CREATED');
    summary.permission = { asked, deniedResult: d.end?.result, fileAfterDeny: afterDeny, allowedResult: a.end?.result, fileAfterAllow: fs.existsSync(file),
      content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
    log('6 permission', JSON.stringify(summary.permission));
  }

  // 7. AskUserQuestion answered through allow(updatedInput)
  {
    let ask = null;
    s.policy = p => {
      if (p.toolName !== 'AskUserQuestion') { s.allow(p.requestId); return; }
      ask = p;
      const q = p.input.questions[0];
      s.allow(p.requestId, { ...p.input, answers: { [q.question]: 'Azul' } });
    };
    const r = await turn(s, 'Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: Rojo and Azul. After I answer, reply with exactly the color I chose and nothing else.');
    summary.askUserQuestion = {
      asked: Boolean(ask), question: ask?.input.questions?.[0]?.question, options: ask?.input.questions?.[0]?.options?.map(o => o.label),
      answeredWith: ask && { answers: { [ask.input.questions[0].question]: 'Azul' } },
      modelReceived: ask ? s.toolResults.get(ask.toolUseId)?.content : null,
      result: r.end?.result,
    };
    log('7 AskUserQuestion', JSON.stringify(summary.askUserQuestion));
    s.policy = p => s.allow(p.requestId);
  }

  // 8. close while Claude writes and one more message is queued: the queue must not run unattended
  {
    const states = [];
    s.on('message', m => states.push(m));
    let startsDuringClose = 0;
    const firstText = waitFor(s, 'text', () => true, 60000);
    s.send(LONG);
    await firstText;
    const queued = s.send('After that, also write the numbers from eighty-one to ninety.');
    await sleep(300);
    const snapshot = tree(s.child.pid);
    s.on('turn-start', () => { startsDuringClose += 1; });
    const tc = performance.now();
    const closed = await s.close();
    const closeMs = Math.round(performance.now() - tc);
    await sleep(1500);
    summary.closeQueued = {
      closed, closeMs, stopRequest: s.writes.map(w => JSON.parse(w)).filter(w => w.type === 'control_request' && w.request.subtype === 'interrupt').at(-1)?.request,
      queuedLifecycle: states.filter(m => m.uuid === queued).map(m => m.state), turnStartsDuringClose: startsDuringClose,
      treeBeforeClose: [...new Set(snapshot.map(p => p.name))].sort(), treeSize: snapshot.length,
      survivors: alive(snapshot.map(p => p.pid)), namingSession: namingSession(s.sessionId), costUsd: +s.costs.reduce((x, y) => x + y, 0).toFixed(4),
    };
    log('8 close with a queued message', JSON.stringify(summary.closeQueued));
  }

  // 10. interrupt (sendUrgent) and then close while Bash `sleep 20` runs: the CLI kills the tool's bash.exe but
  // Git Bash's sleep.exe hangs off a dead parent; StreamSession must reap it both times.
  {
    const b = open({ model: 'haiku' });
    const reaped = [];
    b.on('debug', m => { reaped.push(m); log('  debug', m); });
    await b.start();
    const sleepsBefore = new Set(sleeps().map(p => p.ProcessId));
    const newSleeps = () => sleeps().filter(p => !sleepsBefore.has(p.ProcessId));

    let bashStarted = waitFor(b, 'tool', t => t.name === 'Bash', 60000);
    b.send('Use the Bash tool to run exactly this command: sleep 20\nThen reply with exactly: DONE');
    await bashStarted;
    await sleep(4000);
    const runningBefore = newSleeps().map(p => p.ProcessId);
    const tu = performance.now();
    const second = waitFor(b, 'turn-end').then(() => waitFor(b, 'turn-end'));
    await b.sendUrgent('Stop. Reply with exactly: PARADO');
    const sentMs = Math.round(performance.now() - tu);
    const e2 = await second;
    for (let i = 0; i < 30 && !reaped.length; i += 1) await sleep(200);
    await sleep(800);
    summary.interruptDuringBash = { sleepRunningBefore: runningBefore, urgentSentAfterMs: sentMs, result: e2?.result, reaped, sleepsStillRunning: newSleeps().map(p => p.ProcessId) };
    log('10a interrupt during Bash', JSON.stringify(summary.interruptDuringBash));

    bashStarted = waitFor(b, 'tool', t => t.name === 'Bash', 60000);
    b.send('Use the Bash tool to run exactly this command: sleep 20\nThen reply with exactly: DONE');
    await bashStarted;
    await sleep(4000);
    const snapshot = tree(b.child.pid);
    const runningBeforeClose = newSleeps().map(p => p.ProcessId);
    const tc = performance.now();
    const closed = await b.close();
    const closeMs = Math.round(performance.now() - tc);
    await sleep(1500);
    summary.closeDuringBash = {
      sleepRunningBefore: runningBeforeClose, closed, closeMs, treeBeforeClose: snapshot.map(p => p.name).filter(n => /bash|sleep|claude/i.test(n)),
      survivorsFromTree: alive(snapshot.map(p => p.pid)), sleepsStillRunning: newSleeps().map(p => ({ pid: p.ProcessId, parent: p.ParentProcessId, cmd: p.CommandLine })),
      namingSession: namingSession(b.sessionId), costUsd: +b.costs.reduce((x, y) => x + y, 0).toFixed(4),
    };
    log('10b close during Bash', JSON.stringify(summary.closeDuringBash));
    // A `sleep 20` left behind would keep the scratch folder busy until it ends by itself.
    for (let i = 0; i < 25 && newSleeps().length; i += 1) await sleep(1000);
  }

  // 9. the user's real default model: which permission mode, and does can_use_tool fire?
  if (OPUS) {
    const o = open({});
    const asked = [];
    o.policy = p => { asked.push(p.toolName); o.allow(p.requestId); };
    await o.start();
    const r = await turn(o, 'Use the Write tool to create a file named opus.txt containing the word hi. Then reply exactly: OK');
    const before = tree(o.child.pid).map(p => p.pid);
    const closed = await o.close();
    await sleep(1500);
    summary.defaultModel = { model: o.model, permissionMode: o.permissionMode, permissionAsked: asked, result: r.end?.result,
      fileCreated: fs.existsSync(path.join(CWD, 'opus.txt')), closed, survivors: alive(before), costUsd: +o.costs.reduce((x, y) => x + y, 0).toFixed(4) };
    log('9 default model', JSON.stringify(summary.defaultModel));
  }

  console.log('\nSUMMARY\n' + JSON.stringify(summary, null, 2));
}

// Nothing may hang forever: after 15 min, give up (sessions are still closed and the folder removed).
const watchdog = setTimeout(() => { log('WATCHDOG: giving up'); cleanup().finally(() => process.exit(2)); }, 15 * 60 * 1000);
main().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => { await cleanup(); clearTimeout(watchdog); });
