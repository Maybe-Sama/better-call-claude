// AgentCall hook bridge: `node agentcall-hook.js <endpoint>` forwards the hook payload (stdin) to
// AgentCall at http://127.0.0.1:32147/hooks/<endpoint> and prints its answer for Claude Code.
//
// Command hooks instead of "type": "http" because:
//   - AgentCall closed → this exits silently and Claude Code works as usual. HTTP hooks print
//     "hook error ... ECONNREFUSED" on every prompt, tool call and turn.
//   - Claude Code does not run HTTP hooks for SessionStart at all.
//   - "/saul on" while AgentCall is closed opens it, waits until it listens, then forwards.
// Held hooks (question, permission, Stop) wait for the call without a timeout; if Claude Code
// kills this process, the connection closes and AgentCall drops the call.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const BASE = 'http://127.0.0.1:32147';
const ENDPOINTS = new Set(['session-start', 'user-prompt-submit', 'ask-user', 'permission', 'post-tool-use', 'stop', 'stop-failure']);
const HELD = new Set(['ask-user', 'permission', 'stop']);
const TURN_ON = /^\s*\/(?:agentcall:)?(?:saul|better-call-saul)\s+on\s*$/i;
const STARTUP_MS = 25000;

// Resolves with the response body (status 200), or null when AgentCall is not reachable.
function request(method, url, body, timeoutMs) {
  return new Promise(resolve => {
    const req = http.request(url, {
      method,
      agent: false, // no keep-alive socket holding the process open
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-AgentCall-Mode': process.env.AGENTCALL_SESSION_MODE || '',
      } : {},
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(res.statusCode === 200 ? data : null));
      res.on('error', () => resolve(null));
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve(null));
    if (body) req.write(body);
    req.end();
  });
}

// The copy of AgentCall that ran last (it writes launch.json), else the one next to this plugin,
// else the default install folder.
function launchTarget() {
  const data = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'AgentCall') : null;
  const candidates = [];
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'launch.json'), 'utf8'));
    if (saved.electron && saved.appDir) candidates.push(saved);
  } catch { /* AgentCall never ran on this machine */ }
  for (const appDir of [path.resolve(__dirname, '..', '..'), data && path.join(data, 'app')]) {
    if (appDir) candidates.push({ electron: path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe'), appDir });
  }
  return candidates.find(c => fs.existsSync(c.electron) && fs.existsSync(path.join(c.appDir, 'package.json')));
}

async function forward(endpoint, input) {
  const answer = await request('POST', `${BASE}/hooks/${endpoint}`, input, HELD.has(endpoint) ? 0 : 5000);
  if (answer === null) return false;
  if (answer.trim() && answer.trim() !== '{}') process.stdout.write(answer);
  return true;
}

async function main() {
  const endpoint = process.argv[2];
  if (!ENDPOINTS.has(endpoint)) return;
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { return; }
  if (await forward(endpoint, input)) return;
  // AgentCall is closed. Only "/saul on" opens it; everything else continues as if it did not exist.
  if (endpoint !== 'user-prompt-submit' || !TURN_ON.test(String(payload.prompt || ''))) return;
  const target = launchTarget();
  if (!target) return;
  spawn(target.electron, [target.appDir], { cwd: target.appDir, detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + STARTUP_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (await request('GET', `${BASE}/health`, null, 700)) { await forward(endpoint, input); return; }
  }
}

// No process.exit(): it could cut the stdout write short; nothing else keeps the process alive.
main().catch(() => {});
