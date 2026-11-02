'use strict';
// StreamSession: one Claude Code session that AgentCall drives itself through `claude -p` stream-json,
// AgentCall's optional ConversationSessionProvider. Protocol verified on Claude Code 2.1.289 in
// docs/spikes/claude-stream-json.md: Claude's text arrives while it is written, messages can be added
// while Claude works, an interrupt really stops the turn, and permission prompts (AskUserQuestion
// included) come back here to be answered by voice.
//
// Inputs: start(), send(text), sendUrgent(text), interrupt(), allow()/deny(), close().
// Outputs: 'turn-start' · 'assistant-start' {messageId} · 'text' {delta} · 'tool' {name, toolUseId} · 'assistant-message' {text, aborted}
// · 'turn-end' {terminalReason, aborted, isError, result} · 'message' {uuid, state} · 'permission'
// {requestId, toolName, input, description, toolUseId} · 'permission-cancelled' {requestId} · 'raw' (every
// stdout object, for logs) · 'debug' (string) · 'exit' {code, signal} · 'error' (only emitted when someone listens).
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const START_TIMEOUT_MS = 30000;
const INTERRUPT_TIMEOUT_MS = 3000;
const CLOSE_STEP_MS = 3000;       // close(): each wait (turn end after the interrupt, exit after stdin) is at most this
const SNAPSHOT_MS = 2000;         // never hold a stop longer than this for the process snapshot
const DRAIN_MS = 10000;           // close() on a CLI without cancel_queued: stop queued turns for at most this long
const EXIT_DRAIN_MS = 1000;       // after 'exit', wait for 'close' (stdout read to the end) at most this long
const MAX_LINE = 64 * 1024 * 1024; // a stdout line longer than this is dropped
const REAP_AFTER_MS = 500;        // after an interrupted tool, let the CLI finish killing its shell
const STDERR_KEEP = 4000;

// Without these AgentCall cannot know when Claude took a message or stop it reliably.
const REQUIRED = ['interrupt_receipt_v1', 'msg_lifecycle_v1'];
// priority:"now" has no capability of its own in 2.1.289's schema; it was verified on CLIs that announce
// the "send now" family, so that is what gates it.
const SEND_NOW = 'interrupt_send_now_v1';
const CANCEL_QUEUED = 'interrupt_cancel_queued_v1'; // interrupt + cancel_queued:true = Stop (the queue too)

// Variables Claude Code sets for the processes it runs (QUe() in 2.1.289) plus its entrypoint and IPC.
// AgentCall may itself be launched from a Claude hook; the driven session must start as a top-level
// session of its own, not as that session's child. User configuration (CLAUDE_CODE_GIT_BASH_PATH…) stays.
const PARENT_SESSION_VARS = new Set(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT', 'TRACEPARENT', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']);

function childEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) if (!PARENT_SESSION_VARS.has(key.toUpperCase())) out[key] = value;
  out.AGENTCALL_SESSION_MODE = 'off'; // AgentCall's own plugin hooks must not ring inside the sessions it drives
  return out;
}

// claude.cmd cannot be spawned without a shell, so on Windows use claude.exe (native installer) or the
// native binary behind the npm shim. Anything not found is left to spawn, which reports ENOENT.
function resolveClaude(claudePath = 'claude', { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return claudePath;
  const win = path.win32;
  const behindShim = dir => win.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (/[\\/]/.test(claudePath)) {
    if (/\.cmd$/i.test(claudePath) && exists(behindShim(win.dirname(claudePath)))) return behindShim(win.dirname(claudePath));
    return claudePath;
  }
  const name = claudePath.replace(/\.(exe|cmd)$/i, '');
  for (const dir of String(env.PATH ?? env.Path ?? '').split(';')) {
    if (!dir) continue;
    if (exists(win.join(dir, `${name}.exe`))) return win.join(dir, `${name}.exe`);
    if (exists(win.join(dir, `${name}.cmd`)) && exists(behindShim(dir))) return behindShim(dir);
  }
  return claudePath;
}

// Kills pid and everything under it (the spike saw the Bash tool's children survive a plain kill). Not
// taskkill /T: Windows keeps the pid of a dead parent, and once that pid is reused /T takes unrelated
// processes along (explorer.exe…); listTree only follows a parent link to a younger child.
// expect: the {pid, name, created} seen before; if pid now belongs to another process, nothing is killed.
async function killTree(pid, child, expect = null) {
  if (process.platform !== 'win32') {
    try { if (child) child.kill('SIGKILL'); else process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    return;
  }
  const tree = await Promise.resolve().then(() => listTree(pid)).catch(() => null);
  if (expect && !(tree || []).some(p => p.pid === pid && sameProcess(expect, p))) return; // gone, or pid reused
  const pids = [...new Set([pid, ...(tree || []).map(p => p.pid)])];
  await new Promise(resolve => {
    childProcess.execFile('taskkill', ['/F', ...pids.flatMap(id => ['/PID', String(id)])], { windowsHide: true }, () => resolve());
  });
}

// Our own leftover queries carry the session id on their command line: they must not report each other.
const OWN_QUERY = "$_.CommandLine -notlike '*Get-CimInstance Win32_Process*'";
const PROCESS_FIELDS = "ProcessId,ParentProcessId,Name,@{n='Created';e={$_.CreationDate.ToFileTimeUtc()}}";

// Resolves the listed processes, or null when the query failed (a failed look is not an empty one).
function powershell(script) {
  return new Promise(resolve => {
    childProcess.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      try {
        const out = String(stdout || '').trim();
        if (err && !out) { resolve(null); return; }
        const v = JSON.parse(out || '[]');
        resolve((Array.isArray(v) ? v : [v]).map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, created: p.Created })));
      } catch { resolve(null); }
    });
  });
}

// Rows of Git Bash's `ps -e` (MSYS pids): PID PPID PGID WINPID TTY UID STIME COMMAND, sometimes after a status letter.
function parsePs(stdout) {
  return String(stdout || '').split('\n').slice(1).map(line => line.trim().split(/\s+/))
    .map(f => (/^\d+$/.test(f[0]) ? f : f.slice(1)))
    .filter(f => f.length >= 4 && f.slice(0, 4).every(x => /^\d+$/.test(x)))
    .map(f => ({ pid: +f[0], ppid: +f[1], winpid: +f[3] }));
}

// Git Bash's fork()+exec() leaves a command's Windows parent dead while the command runs (seen live:
// sleep.exe's parent pid was already gone), so no Windows tree walk, taskkill /T included, reaches it; MSYS's
// own table still links it to the bash that started it. ps.exe sits in Git's usr\bin, next to git's cmd\.
function msysProcesses(env = process.env) {
  const win = path.win32;
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const gitBash = env.CLAUDE_CODE_GIT_BASH_PATH;
  const candidates = [
    gitBash && win.join(win.dirname(gitBash), 'ps.exe'),
    gitBash && win.join(win.dirname(gitBash), '..', 'usr', 'bin', 'ps.exe'),
    ...dirs.filter(d => fs.existsSync(win.join(d, 'git.exe'))).map(d => win.join(d, '..', 'usr', 'bin', 'ps.exe')),
    'C:\\Program Files\\Git\\usr\\bin\\ps.exe',
  ].filter(Boolean);
  const ps = candidates.find(c => fs.existsSync(c));
  if (!ps) return Promise.resolve([]); // no Git Bash: no MSYS processes to link
  return new Promise(resolve => {
    childProcess.execFile(ps, ['-e'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      const rows = parsePs(stdout);
      resolve(err || !rows.length ? null : rows);
    });
  });
}

// The processes under pid: Windows parent links plus the MSYS links, until nothing more joins. Names come
// from the Windows list. A Windows link is followed only to a child younger than its parent (Windows keeps
// the pid of a dead parent, and pids are reused). Parent links only hold while the parents are alive: take
// it before stopping a tool.
function linkTree(pid, all, msys) {
  const byPid = new Map(all.map(p => [p.pid, p]));
  const ids = new Set([pid]);
  const ours = new Set(); // MSYS pids
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) {
      if (!ids.has(p.pid) && ids.has(p.ppid) && !(byPid.get(p.ppid)?.created > p.created)) { ids.add(p.pid); grew = true; }
    }
    for (const p of msys) {
      if (!ours.has(p.pid) && (ids.has(p.winpid) || ours.has(p.ppid))) { ours.add(p.pid); ids.add(p.winpid); grew = true; }
    }
  }
  return all.filter(p => ids.has(p.pid)).map(p => ({ pid: p.pid, name: p.name, created: p.created }));
}

// null when either look failed: an incomplete tree must never decide what to kill.
async function listTree(pid, { env = process.env } = {}) {
  if (process.platform !== 'win32' || !Number.isInteger(pid)) return [];
  const [all, msys] = await Promise.all([
    powershell(`Get-CimInstance Win32_Process | Select-Object ${PROCESS_FIELDS} | ConvertTo-Json -Compress`),
    msysProcesses(env),
  ]);
  return all && msys ? linkTree(pid, all, msys) : null;
}

// What is still running of a tree snapshot (same pid, name and start time), plus processes naming this
// session on their command line (claude.exe has --session-id/--resume). Limitation: something started after
// the snapshot and orphaned by an interrupt is found by neither.
// The same process, not just the same pid: Windows reuses pids, so the start time must match as well.
function sameProcess(a, b) {
  return a.pid === b.pid && a.created != null && a.created === b.created && String(a.name).toLowerCase() === String(b.name).toLowerCase();
}

// null when the check itself failed (never reported as "nothing left").
function findLeftovers(sessionId, tree = []) {
  if (process.platform !== 'win32' || !/^[\w-]+$/.test(String(sessionId))) return Promise.resolve([]);
  const ids = tree.map(p => Number(p.pid)).filter(Number.isInteger);
  const ofTree = ids.length ? `$_.ProcessId -in @(${ids.join(',')}) -or ` : '';
  return powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ${OWN_QUERY} -and (${ofTree}$_.CommandLine -like '*${sessionId}*') } | Select-Object ${PROCESS_FIELDS} | ConvertTo-Json -Compress`)
    .then(found => found && found.filter(p => !ids.includes(p.pid) || tree.some(t => sameProcess(t, p))));
}

class StreamSession extends EventEmitter {
  constructor({
    cwd, claudePath = 'claude', resume = null, sessionId = null, model = null, appendSystemPrompt = null,
    spawn = childProcess.spawn, env = process.env, now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id),
    killTree: kill = killTree, listTree: list = listTree, findLeftovers: leftovers = findLeftovers,
  } = {}) {
    super();
    this.cwd = cwd;
    this.claudePath = claudePath;
    this.resume = resume;
    this.sessionId = resume || sessionId || crypto.randomUUID();
    this.model = model;
    this.appendSystemPrompt = appendSystemPrompt;
    this.spawn = spawn;
    this.env = env;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.killTree = kill;
    this.listTree = list;
    this.findLeftovers = leftovers;
    this.capabilities = null;     // from the first system/init, which Claude Code only sends when a turn starts
    this.claudeCodeVersion = null;
    this.permissionMode = null;
    this.child = null;
    this.ready = false;
    this.failed = false;          // start() gave up: the session takes no messages
    this.exitInfo = null;
    this.stderr = '';
    this.starting = null;
    this.closing = null;
    this.stdinEnded = false;
    this.buf = '';
    this.seq = 0;
    this.controls = new Map();    // our control_request id → resolve(payload | null)
    this.permissions = new Map(); // CLI request id → tool input, until answered
    this.pending = new Map();     // uuid → last lifecycle state, for messages not finished yet
    this.turnRunning = false;
    this.turns = 0;               // turns started, to tell one turn from the next
    this.tools = new Set();       // top-level tool_use ids whose result has not arrived
    this.blocks = new Map();      // parent_tool_use_id ('' = top level) → Map(index → block type)
    this.message = null;          // top-level assistant message being written: { id, text }
    this.speaking = null;         // index of the top-level text block that has streamed text
  }

  get busy() { return this.turnRunning || this.pending.size > 0; }
  get idle() { return this.ready && !this.exitInfo && !this.closing && !this.busy; }

  args() {
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages',
      '--replay-user-messages', // the only spike runs that saw command_lifecycle used it
      '--permission-prompt-tool', 'stdio']; // without it prompts are auto-denied and AskUserQuestion is missing
    if (this.resume) a.push('--resume', this.resume);
    else a.push('--session-id', this.sessionId);
    if (this.model) a.push('--model', this.model);
    if (this.appendSystemPrompt) a.push('--append-system-prompt', this.appendSystemPrompt);
    return a;
  }

  // Resolves once Claude Code answers `initialize` (it is up and logged in: ~1.2 s). system/init, with the
  // model and the capabilities, only comes when the first turn starts; a CLI lacking a required capability
  // is refused there ('error' + close()).
  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      this._rejectStart = reject;
      const env = childEnv(this.env);
      try {
        this.child = this.spawn(resolveClaude(this.claudePath, { env }), this.args(), { cwd: this.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        reject(err);
        return;
      }
      this.startedAt = this.now();
      const child = this.child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => this._onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-STDERR_KEEP); });
      child.stdin.on('error', err => this._error(err)); // EPIPE once the process is gone
      child.on('error', err => {
        if (!this.ready) reject(err); else this._error(err);
        if (child.pid == null) this._onExit(null, null); // spawn failed: no 'exit' follows
      });
      // 'exit' can come before the last stdout data; 'close' comes once stdout is read to the end (unless a
      // grandchild holds the pipe open: then after a second).
      child.on('exit', (code, signal) => {
        const timer = this.setTimer(() => this._onExit(code, signal), EXIT_DRAIN_MS);
        child.once('close', () => { this.clearTimer(timer); this._onExit(code, signal); });
      });
      this._control({ subtype: 'initialize' }, START_TIMEOUT_MS).then(payload => {
        if (this.exitInfo) return;
        if (!payload || payload.error) {
          this.failed = true; // no messages for a session that never started
          reject(new Error(payload ? `Claude Code did not start: ${payload.error}` : `Claude Code did not answer within ${START_TIMEOUT_MS / 1000} s.`));
          Promise.resolve().then(() => this.killTree(child.pid, child)).catch(err => this._error(err));
          return;
        }
        this.ready = true;
        this.readyMs = this.now() - this.startedAt;
        resolve(payload);
      });
    });
    return this.starting;
  }

  // A new user message; returns its uuid. Claude Code folds it into the running turn at the next tool
  // boundary, or queues it as the next turn ('message' events say which and when).
  // priority 'now' aborts the running turn and starts this one, but only while Claude is writing text: during
  // a tool it either waits for the tool or kills it and the new turn re-runs it (duplicate side effects), and
  // it may drop a message that was still queued. Otherwise the message is sent as a plain one.
  send(text, { priority } = {}) {
    if (this.closing || this.exitInfo || !this.child || this.failed) throw new Error('The Claude Code session is closed.');
    const uuid = crypto.randomUUID();
    const msg = { type: 'user', message: { role: 'user', content: String(text) }, parent_tool_use_id: null, session_id: this.sessionId, uuid };
    if (priority === 'now') {
      const queued = [...this.pending.values()].some(state => state !== 'started');
      if (this.capabilities?.includes(SEND_NOW) && !this.tools.size && !queued) msg.priority = 'now';
    } else if (priority) {
      msg.priority = priority;
    }
    this.pending.set(uuid, 'sent');
    this._write(msg);
    return uuid;
  }

  // "No, para…": stop what Claude is doing, wait for the turn to end, then send. Never re-runs a tool. If the
  // CLI never confirms the stop, the words are sent anyway: they reach Claude at the next tool boundary
  // instead of being lost.
  async sendUrgent(text) {
    if (this.busy) {
      const ended = this._waitFor('turn-end', SNAPSHOT_MS + CLOSE_STEP_MS); // the snapshot before stopping a tool counts too
      await this.interrupt().catch(err => this._error(err));
      await ended;
    }
    return this.send(text);
  }

  // Resolves with the CLI's receipt ({still_queued: [...]}) or null after 3 s. The CLI kills the Bash tool's
  // shell but not what the shell started (sleep, a dev server…): when a tool is running, the process tree is
  // captured first (≤ 2 s) and, once the turn is over, whatever the interrupt orphaned is killed.
  interrupt() {
    if (!this.child || this.exitInfo || this.stdinEnded) return Promise.resolve(null);
    if (!this.tools.size) return this._stop(false);
    // A second "para" during the same tool joins the first: one snapshot, one stop, one reap.
    if (this.interrupting?.turn !== this.turns) {
      const promise = this._interruptTool();
      this.interrupting = { turn: this.turns, promise };
      promise.finally(() => { if (this.interrupting?.promise === promise) this.interrupting = null; }).catch(() => {});
    }
    return this.interrupting.promise;
  }

  async _interruptTool() {
    const turn = this.turns;
    const tree = await this._snapshot();
    // The turn may have ended meanwhile, and the next one be the user's urgent message: never stop that one.
    if (!this.turnRunning || this.turns !== turn || this.exitInfo || this.stdinEnded) return null;
    const ended = this._waitFor('turn-end', CLOSE_STEP_MS);
    const receipt = await this._stop(false);
    if (tree) {
      ended.then(done => done && this._delay(REAP_AFTER_MS).then(() => this._reap(tree))).catch(err => this._error(err));
    }
    return receipt;
  }

  // updatedInput defaults to the input Claude asked with. AskUserQuestion is answered here too:
  // allow(id, {...input, answers: {[question text]: 'label'}}) (multi-select: labels joined with ", ").
  // false (nothing written) when the request was cancelled by the CLI or already answered.
  allow(requestId, updatedInput = this.permissions.get(requestId)) {
    if (!this.permissions.delete(requestId)) return false;
    this._answer(requestId, { behavior: 'allow', updatedInput: updatedInput || {} });
    return true;
  }

  // interrupt: true also ends the turn (result error_during_execution / aborted_tools).
  deny(requestId, message = 'The user declined.', { interrupt = false } = {}) {
    if (!this.permissions.delete(requestId)) return false;
    this._answer(requestId, { behavior: 'deny', message, ...(interrupt ? { interrupt: true } : {}) });
    return true;
  }

  // Closing stdin mid-turn lets the turn run to the end unattended, so a busy session is stopped first (the
  // queued messages too: they would start as soon as the interrupted turn ends). Then stdin ends; a process
  // still alive 3 s later is killed with its whole tree. If a tool was running, what it started and outlived
  // the session is killed too (from a tree snapshot taken first) and reported. Idempotent.
  close() {
    if (!this.closing) this.closing = this._close();
    return this.closing;
  }

  async _close() {
    const done = (exit, killed = false, leftovers = [], checked = true) => ({ code: exit?.code ?? null, signal: exit?.signal ?? null, killed, leftovers, checked });
    if (!this.child || this.exitInfo) return done(this.exitInfo);
    const tree = this.ready ? await this._snapshot() : [];
    // A CLI without cancel_queued starts the next queued message at once: stop those turns too, for a while.
    const deadline = this.now() + DRAIN_MS;
    while (this.ready && this.busy && !this.exitInfo && this.now() < deadline) {
      if (!this.turnRunning && !(await this._settle(CLOSE_STEP_MS))) break;
      const ended = this._waitFor('turn-end', CLOSE_STEP_MS);
      this._stop(true);
      if (!(await ended)) break;
    }
    const stuck = this.ready && this.turnRunning && !this.exitInfo; // still working: do not let it go on alone
    this.stdinEnded = true;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    let exit = stuck ? null : await this._waitExit(CLOSE_STEP_MS);
    const killed = !exit;
    if (killed) {
      await Promise.resolve().then(() => this.killTree(this.child.pid, this.child)).catch(err => this._error(err));
      exit = await this._waitExit(CLOSE_STEP_MS);
    }
    const { leftovers, checked } = await this._reap(tree);
    if (!this.exitInfo) leftovers.unshift({ pid: this.child.pid, name: 'claude' }); // survived even the kill
    if (!checked) this._error(new Error(`Could not check for processes left running by session ${this.sessionId}.`));
    if (leftovers.length) {
      this._error(new Error(`Still running after closing session ${this.sessionId}: ${leftovers.map(p => `${p.name} ${p.pid}`).join(', ')}`));
    }
    return done(exit, killed, leftovers, checked);
  }

  // ── stdout ──────────────────────────────────────────────────────────────

  _onData(chunk) {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE && !this.buf.includes('\n')) {
      this._error(new Error(`Dropped a stdout line longer than ${MAX_LINE} bytes.`));
      this.buf = '';
    }
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; } // warnings and other noise on stdout
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
      // A throwing listener must not escape the stdout callback (it would crash AgentCall's main process).
      try { this._onEvent(ev); } catch (err) { this._error(err); }
    }
  }

  _onEvent(ev) {
    this._emitSafe('raw', ev);
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') this._onInit(ev);
        break; // hook_started/hook_response, status, thinking_tokens…: not needed here
      case 'stream_event':
        this._onStream(ev.event || {}, ev.parent_tool_use_id || '');
        break;
      case 'assistant':
        if (!ev.parent_tool_use_id && this.message && ev.message?.id === this.message.id) {
          for (const b of ev.message.content || []) if (b?.type === 'text') this.message.text += b.text || '';
        }
        break;
      case 'user':
        if (!ev.parent_tool_use_id && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content) if (b?.type === 'tool_result') this.tools.delete(b.tool_use_id);
        }
        break;
      case 'command_lifecycle':
        this._onLifecycle(ev.command_uuid, ev.state);
        break;
      case 'result':
        this._onResult(ev);
        break;
      case 'control_response': {
        const r = ev.response || {};
        const resolve = this.controls.get(r.request_id);
        if (resolve) resolve(r.subtype === 'error' ? { error: r.error || 'error' } : (r.response || {}));
        break;
      }
      case 'control_request':
        this._onControlRequest(ev.request_id, ev.request || {});
        break;
      case 'control_cancel_request':
        if (this.permissions.delete(ev.request_id)) this._emitSafe('permission-cancelled', { requestId: ev.request_id });
        break;
      default:
        break; // rate_limit_event, keep_alive and whatever later versions add
    }
  }

  _onInit(ev) {
    if (ev.session_id) this.sessionId = ev.session_id;
    if (ev.model) this.model = ev.model;
    this.permissionMode = ev.permissionMode || this.permissionMode;
    const first = !this.capabilities;
    this.capabilities = Array.isArray(ev.capabilities) ? ev.capabilities : [];
    this.claudeCodeVersion = ev.claude_code_version || this.claudeCodeVersion;
    if (first) {
      const missing = REQUIRED.filter(c => !this.capabilities.includes(c));
      if (missing.length) {
        this._error(new Error(`The installed Claude Code (${this.claudeCodeVersion || 'unknown version'}) does not support ${missing.join(' and ')}; AgentCall needs it to drive a session. Update Claude Code.`));
        this.close();
        return;
      }
    }
    this._turnStart(); // system/init is re-emitted at the start of every turn
  }

  _onStream(e, parent) {
    if (e.type === 'message_start') {
      this.blocks.set(parent, new Map());
      if (!parent) {
        this.message = { id: e.message?.id || null, text: '' };
        this._turnStart();
        this._emitSafe('assistant-start', { messageId: this.message.id }); // speech rules apply per message
      }
      return;
    }
    if (parent) {
      if (e.type === 'content_block_start') this._blockMap(parent).set(e.index, e.content_block?.type);
      return; // subagent output is not the conversation with the user
    }
    if (e.type === 'content_block_start') {
      const block = e.content_block || {};
      this._blockMap('').set(e.index, block.type);
      if (block.type === 'tool_use') {
        this.tools.add(block.id);
        this._emitSafe('tool', { name: block.name, toolUseId: block.id });
      }
    } else if (e.type === 'content_block_delta') {
      if (e.delta?.type !== 'text_delta' || this._blockMap('').get(e.index) !== 'text' || !e.delta.text) return;
      this.speaking = e.index;
      this._emitSafe('text', { delta: e.delta.text });
    } else if (e.type === 'content_block_stop') {
      // The block is a finished paragraph (on screen too): a sentence written just before a tool call can be
      // spoken while the tool runs instead of after it.
      if (this.speaking === e.index) this._emitSafe('text', { delta: '\n\n' });
      this.speaking = null;
    } else if (e.type === 'message_stop') {
      const done = this.message;
      this.message = null;
      if (done?.text) this._emitSafe('assistant-message', { text: done.text, aborted: false });
    }
  }

  _blockMap(parent) {
    if (!this.blocks.has(parent)) this.blocks.set(parent, new Map());
    return this.blocks.get(parent);
  }

  _onLifecycle(uuid, state) {
    if (!uuid || !state) return;
    if (this.pending.has(uuid)) {
      if (state === 'completed' || state === 'cancelled') this.pending.delete(uuid);
      else this.pending.set(uuid, state);
    }
    if (state === 'started') this._turnStart();
    this._emitSafe('message', { uuid, state });
  }

  _onResult(ev) {
    const terminalReason = ev.terminal_reason || null;
    const aborted = /^aborted/.test(String(terminalReason || ''));
    // A message cut by an interrupt has no message_stop; its partial text still arrives as an assistant event.
    const cut = aborted && this.message?.text ? this.message.text : '';
    this.message = null;
    this.turnRunning = false;
    this.tools.clear();
    this.blocks.clear();
    this.speaking = null;
    for (const [uuid, state] of this.pending) if (state === 'started') this.pending.delete(uuid); // ran in this turn
    if (cut) this._emitSafe('assistant-message', { text: cut, aborted: true });
    this._emitSafe('turn-end', { terminalReason, aborted, isError: Boolean(ev.is_error), result: ev.result ?? '' });
  }

  _turnStart() {
    if (this.turnRunning) return;
    this.turnRunning = true;
    this.turns += 1;
    this.turnStartedAt = this.now();
    this._emitSafe('turn-start');
  }

  _onControlRequest(requestId, request) {
    if (request.subtype === 'can_use_tool') {
      this.permissions.set(requestId, request.input || {});
      this._emitSafe('permission', { requestId, toolName: request.tool_name, input: request.input || {}, description: request.description, toolUseId: request.tool_use_id });
      return;
    }
    // Anything else (hook callbacks, SDK MCP…) was never registered: answer so the CLI does not wait forever.
    this._writeSafe({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `AgentCall does not handle ${request.subtype}` } });
  }

  // ── stdin ───────────────────────────────────────────────────────────────

  _write(obj) {
    if (!this.child || this.exitInfo || this.stdinEnded) throw new Error('The Claude Code session is closed.');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _writeSafe(obj) {
    try { this._write(obj); } catch (err) { this._error(err); }
  }

  _answer(requestId, response) {
    this._writeSafe({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  // Our control request; resolves with the response payload ({error} for an error answer) or null on timeout/exit.
  _control(request, timeoutMs) {
    this.seq += 1;
    const requestId = `req_${this.seq}_${crypto.randomBytes(3).toString('hex')}`;
    return new Promise(resolve => {
      const timer = this.setTimer(() => { if (this.controls.delete(requestId)) resolve(null); }, timeoutMs);
      this.controls.set(requestId, payload => { this.controls.delete(requestId); this.clearTimer(timer); resolve(payload); });
      try {
        this._write({ type: 'control_request', request_id: requestId, request });
      } catch {
        this.controls.get(requestId)?.(null);
      }
    });
  }

  // ── processes ───────────────────────────────────────────────────────────

  // interrupt / Stop. cancelQueued also drops the messages still waiting, when the CLI supports it: only
  // close() asks for it, so nothing the user said is lost otherwise.
  _stop(cancelQueued) {
    const stop = cancelQueued && this.capabilities?.includes(CANCEL_QUEUED);
    return this._control({ subtype: 'interrupt', ...(stop ? { cancel_queued: true } : {}) }, INTERRUPT_TIMEOUT_MS);
  }

  // The process tree now, or null if it could not be read within 2 s.
  _snapshot() {
    const pid = this.child?.pid;
    return new Promise(resolve => {
      const timer = this.setTimer(() => resolve(null), SNAPSHOT_MS);
      Promise.resolve().then(() => this.listTree(pid, { env: this.env })).catch(() => null)
        .then(tree => { this.clearTimer(timer); resolve(Array.isArray(tree) ? tree : null); });
    });
  }

  _delay(ms) { return new Promise(resolve => this.setTimer(resolve, ms)); }

  // Kills what is still alive of a snapshot but no longer hangs under claude.exe (all of it once the session
  // has exited); MCP servers and background shells stay linked and are left alone. Returns what is still
  // running: the killed orphans plus, only reported, anything else naming the session (a terminal on it?).
  async _reap(tree) {
    const known = tree || [];
    let linked = new Set();
    if (!this.exitInfo) {
      if (!known.length) return { leftovers: [], checked: true };
      // Fail closed: without a complete view of what still hangs under claude.exe, kill nothing.
      const now = await this._snapshot();
      if (!now || !now.some(p => p.pid === this.child.pid)) {
        this._debug('could not re-read the process tree after the interrupt: nothing killed');
        return { leftovers: [], checked: false };
      }
      linked = new Set(now.map(p => p.pid));
    }
    const alive = await Promise.resolve().then(() => this.findLeftovers(this.sessionId, known)).catch(() => null);
    if (!alive) return { leftovers: [], checked: false };
    const mine = p => known.find(t => t.pid === p.pid);
    const orphans = alive.filter(p => mine(p) && !linked.has(p.pid) && (this.exitInfo || p.pid !== this.child.pid));
    await Promise.all(orphans.map(p => Promise.resolve().then(() => this.killTree(p.pid, null, mine(p))).catch(err => this._error(err))));
    if (orphans.length && !this.exitInfo) this._debug(`killed what the interrupted tool left running: ${orphans.map(p => `${p.name} ${p.pid}`).join(', ')}`);
    const leftovers = alive.filter(p => orphans.includes(p) || !mine(p)).map(p => ({ pid: p.pid, name: p.name }));
    return { leftovers, checked: true };
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  _waitFor(event, ms) {
    return new Promise(resolve => {
      const done = value => { this.clearTimer(timer); this.off(event, onEvent); this.off('exit', onExit); resolve(value); };
      const onEvent = value => done(value ?? true);
      const onExit = () => done(null);
      const timer = this.setTimer(() => done(null), ms);
      this.on(event, onEvent);
      this.on('exit', onExit);
    });
  }

  // Resolves true once a turn is running, false when there is nothing left to wait for (or after ms).
  _settle(ms) {
    return new Promise(resolve => {
      const names = ['turn-start', 'message', 'exit'];
      let timer = null;
      const done = value => { this.clearTimer(timer); for (const n of names) this.off(n, check); resolve(value); };
      const check = () => { if (this.turnRunning || !this.busy || this.exitInfo) done(this.turnRunning); };
      timer = this.setTimer(() => done(false), ms);
      for (const n of names) this.on(n, check);
      check();
    });
  }

  _waitExit(ms) {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return this._waitFor('exit', ms).then(() => this.exitInfo);
  }

  _onExit(code, signal) {
    if (this.exitInfo) return;
    this.exitInfo = { code, signal };
    for (const resolve of [...this.controls.values()]) resolve(null);
    this.pending.clear();
    const prompts = [...this.permissions.keys()];
    this.permissions.clear();
    for (const requestId of prompts) this._emitSafe('permission-cancelled', { requestId }); // nobody can answer them now
    if (this.turnRunning) { // died mid-turn: the turn is over for whoever is speaking or waiting for it
      this.turnRunning = false;
      this.message = null;
      this.tools.clear();
      this._emitSafe('turn-end', { terminalReason: 'exit', aborted: true, isError: true, result: '' });
    }
    if (!this.ready && this._rejectStart) {
      const tail = this.stderr.trim().split('\n').slice(-5).join('\n');
      this._rejectStart(new Error(`Claude Code exited before it was ready (code ${code}${signal ? `, ${signal}` : ''})${tail ? `: ${tail}` : ''}`));
    }
    this._emitSafe('exit', this.exitInfo);
  }

  // Events emitted from child-process callbacks: a throwing listener must not crash AgentCall's main process.
  _emitSafe(event, payload) {
    try { this.emit(event, payload); } catch (err) { this._error(err); }
  }

  _debug(message) { this._emitSafe('debug', message); }

  // An 'error' without listeners (or a throwing one) would throw inside AgentCall's main process.
  _error(err) {
    try { if (this.listenerCount('error')) this.emit('error', err); } catch { /* nowhere left to report it */ }
  }
}

module.exports = { StreamSession, resolveClaude, childEnv, listTree, findLeftovers, parsePs, linkTree, sameProcess, REQUIRED_CAPABILITIES: REQUIRED };
