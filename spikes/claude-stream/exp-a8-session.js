// A8: session identity — --session-id, --resume of a plain `claude -p` session, and whether later
// resumes / the transcript see the streamed turns. Scratch sessions only (cwd = the spike repo).
//   node exp-a8-session.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ClaudeStreamClient, saveResult, resolveClaudeBin, SPIKE_CWD } = require('./lib/client');

const PROJECT_DIR = path.join(os.homedir(), '.claude', 'projects', SPIKE_CWD.replace(/[:\\/.]/g, '-'));

function oneshot(prompt, extra = []) {
  const r = spawnSync(resolveClaudeBin(), ['-p', prompt, '--model', 'haiku', '--max-turns', '2', '--output-format', 'json', ...extra], { cwd: SPIKE_CWD, env: { ...process.env, AGENTCALL_SESSION_MODE: 'off' }, encoding: 'utf8', timeout: 120000, windowsHide: true });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* not json */ }
  return { exit: r.status, session_id: j && j.session_id, result: j && String(j.result).slice(0, 160), stderr: (r.stderr || '').slice(0, 200) };
}

async function streamTurns(opts, prompts) {
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 2, ...opts }).start();
  const results = [];
  for (const p of prompts) {
    const from = c.events.length;
    c.sendUser(p);
    const r = await c.waitFor(ev => ev.type === 'result', { from, timeoutMs: 90000 });
    results.push(r ? String(r.ev.result).slice(0, 160) : null);
  }
  const init = c.events.find(r => r.ev.type === 'system' && r.ev.subtype === 'init');
  return { c, initSessionId: init && init.ev.session_id, sessionIds: [...new Set(c.events.map(r => r.ev.session_id).filter(Boolean))], results };
}

function transcript(id) {
  const f = path.join(PROJECT_DIR, `${id}.jsonl`);
  if (!fs.existsSync(f)) return { exists: false, file: f };
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
  const users = lines.filter(l => l.type === 'user' && l.message && typeof l.message.content === 'string').map(l => l.message.content.slice(0, 60));
  return { exists: true, file: f, lines: lines.length, types: [...new Set(lines.map(l => l.type))], userPrompts: users, hasInterruptMarker: lines.some(l => JSON.stringify(l.message || '').includes('Request interrupted')) };
}

async function main() {
  const out = {};
  // 1. --session-id for a brand-new streaming session.
  const sid = crypto.randomUUID();
  const s1 = await streamTurns({ sessionId: sid }, ['Reply with exactly: NEW-SESSION-OK']);
  await s1.c.kill();
  out.sessionIdFlag = { requested: sid, init: s1.initSessionId, all: s1.sessionIds, matches: s1.initSessionId === sid, results: s1.results, transcript: transcript(sid) };
  console.log('session-id', JSON.stringify(out.sessionIdFlag).slice(0, 400));

  // 2. Plain one-shot -p session, then --resume it in stream-json mode.
  const base = oneshot('For later: my favorite color is TEAL. Reply with exactly: OK');
  out.base = base;
  console.log('base', JSON.stringify(base));
  const s2 = await streamTurns({ resume: base.session_id }, [
    'What is my favorite color? Reply with one word.',
    'For later: my favorite animal is OTTER. Reply with exactly: OK',
  ]);
  out.resumeStream = { init: s2.initSessionId, all: s2.sessionIds, sameAsBase: s2.initSessionId === base.session_id, results: s2.results };
  console.log('resume-stream', JSON.stringify(out.resumeStream));

  // 3. While the streaming process is still alive and idle: a second process resumes the same id.
  const concurrent = oneshot('What are my favorite color and my favorite animal? Reply with two words, or NONE for each one you were not told.', ['--resume', base.session_id]);
  out.concurrentResume = { ...concurrent, sameId: concurrent.session_id === base.session_id };
  console.log('concurrent', JSON.stringify(out.concurrentResume));
  // The streaming process continues after the other process wrote to the session.
  const from = s2.c.events.length;
  s2.c.sendUser('Reply with exactly: STILL-HERE');
  const r3 = await s2.c.waitFor(ev => ev.type === 'result', { from, timeoutMs: 60000 });
  out.streamAfterConcurrent = r3 ? String(r3.ev.result).slice(0, 80) : null;
  await s2.c.kill();

  // 4. After the streaming process exited: a plain resume sees the streamed turns?
  const later = oneshot('What are my favorite color and my favorite animal? Reply with two words, or NONE for each one you were not told.', ['--resume', base.session_id]);
  out.laterResume = { ...later, sameId: later.session_id === base.session_id };
  console.log('later', JSON.stringify(out.laterResume));

  // 5. Transcripts on disk.
  out.transcripts = { base: transcript(base.session_id) };
  for (const id of new Set([concurrent.session_id, later.session_id].filter(x => x && x !== base.session_id))) out.transcripts[id] = transcript(id);
  console.log('transcripts', JSON.stringify(out.transcripts).slice(0, 1500));
  console.log('saved', saveResult('a8-session', out));
}
main().catch(e => { console.error(e); process.exit(1); });
