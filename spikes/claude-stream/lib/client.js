// Probe client for `claude -p --input-format stream-json --output-format stream-json`.
// Spike only (docs/spikes/claude-stream-json.md): spawns the CLI, writes JSONL to stdin, parses
// stdout JSONL and timestamps every line with performance.now() relative to spawn.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');

// Scratch project every spawned claude runs in. Never the AgentCall repo or a real project.
const SPIKE_CWD = process.env.SPIKE_CWD || 'E:\\tmp\\claude-stream-spike';

// claude.cmd cannot be spawned without a shell, so resolve the native binary behind the npm shim.
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const viaShim = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(path.join(dir, 'claude.cmd')) && fs.existsSync(viaShim)) return viaShim;
    const direct = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(direct)) return direct;
  }
  throw new Error('claude binary not found; set CLAUDE_BIN');
}

// One-word label for an output line, used for event-type sequences in results.
function label(ev) {
  if (!ev || typeof ev !== 'object') return 'invalid';
  switch (ev.type) {
    case 'stream_event': {
      const e = ev.event || {};
      let s = `se:${e.type}`;
      if (e.content_block) s += `:${e.content_block.type}`;
      if (e.delta && e.delta.type) s += `:${e.delta.type}`;
      if (ev.parent_tool_use_id) s += ':sub';
      return s;
    }
    case 'assistant':
    case 'user': {
      const c = ev.message && ev.message.content;
      const kinds = Array.isArray(c) ? c.map(b => b.type).join('+') : typeof c;
      return `${ev.type}:${kinds}${ev.isReplay ? ':replay' : ''}${ev.parent_tool_use_id ? ':sub' : ''}`;
    }
    case 'system': return `system:${ev.subtype}`;
    case 'result': return `result:${ev.subtype}`;
    case 'control_request': return `control_request:${ev.request && ev.request.subtype}`;
    case 'control_response': return `control_response:${ev.response && ev.response.subtype}`;
    default: return `${ev.type}${ev.subtype ? ':' + ev.subtype : ''}`;
  }
}

// Text of an assistant/user message (string or blocks).
function textOf(ev) {
  const c = ev && ev.message && ev.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map(b => b.type === 'text' ? b.text : b.type === 'tool_result'
    ? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) : '').join('');
}

class ClaudeStreamClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.events = [];   // { t, ev, label }
    this.writes = [];   // { t, kind, obj }
    this.stderr = '';
    this.sessionId = null;
    this.exit = null;
    this._reqSeq = 0;
    this._pendingControl = new Map();
    this.onControlRequest = null; // async (req) => response object for the CLI's control_request
  }

  args() {
    const o = this.opts;
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    if (o.partial !== false) a.push('--include-partial-messages');
    if (o.model) a.push('--model', o.model);
    if (o.maxTurns) a.push('--max-turns', String(o.maxTurns));
    if (o.replay) a.push('--replay-user-messages');
    if (o.permissionMode) a.push('--permission-mode', o.permissionMode);
    if (o.permissionPromptTool) a.push('--permission-prompt-tool', o.permissionPromptTool);
    if (o.sessionId) a.push('--session-id', o.sessionId);
    if (o.resume) a.push('--resume', o.resume);
    if (o.settings) a.push('--settings', o.settings);
    if (o.extraArgs) a.push(...o.extraArgs);
    return a;
  }

  start() {
    const bin = resolveClaudeBin();
    const env = { ...process.env, AGENTCALL_SESSION_MODE: 'off', ...(this.opts.env || {}) };
    delete env.CLAUDECODE; // we may run under a Claude Code parent; the child must not think it is nested
    this.t0 = performance.now();
    this.wall0 = Date.now(); // to place hook log entries (Date.now) on the same timeline
    this.child = spawn(bin, this.args(), { cwd: this.opts.cwd || SPIKE_CWD, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pid = this.child.pid;
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this._onLine(line);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', d => { this.stderr += d; });
    this.child.stdin.on('error', err => this.emit('stdin-error', err));
    this.exited = new Promise(resolve => {
      this.child.on('exit', (code, signal) => {
        this.exit = { t: this.now(), code, signal };
        this.emit('exit', this.exit);
        resolve(this.exit);
      });
    });
    return this;
  }

  now() { return performance.now() - this.t0; }

  _onLine(line) {
    const t = this.now();
    let ev;
    try { ev = JSON.parse(line); } catch { ev = { type: 'unparsed', raw: line.slice(0, 300) }; }
    const rec = { t, ev, label: label(ev) };
    this.events.push(rec);
    if (ev.session_id && !this.sessionId) this.sessionId = ev.session_id;
    if (ev.type === 'control_response') {
      const id = ev.response && ev.response.request_id;
      const p = this._pendingControl.get(id);
      if (p) { this._pendingControl.delete(id); p({ t, ev }); }
    }
    if (ev.type === 'control_request' && this.onControlRequest) {
      Promise.resolve(this.onControlRequest(ev, t)).then(response => {
        if (response) this.write({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response } }, 'control_response');
      });
    }
    this.emit('line', rec);
  }

  write(obj, kind = obj.type) {
    const t = this.now();
    this.writes.push({ t, kind, obj });
    this.child.stdin.write(JSON.stringify(obj) + '\n');
    return t;
  }

  // User message as the Agent SDK sends it.
  sendUser(text, extra = {}) {
    if (extra.uuid === true) extra = { ...extra, uuid: require('node:crypto').randomUUID() };
    return this.write({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
      ...extra,
    }, 'user');
  }

  // Control request; resolves with { t, ev } of the matching control_response (or null on timeout).
  control(request, timeoutMs = 30000) {
    const request_id = `req_${++this._reqSeq}_${Math.random().toString(36).slice(2, 8)}`;
    const p = new Promise(resolve => {
      this._pendingControl.set(request_id, resolve);
      setTimeout(() => { if (this._pendingControl.delete(request_id)) resolve(null); }, timeoutMs);
    });
    const t = this.write({ type: 'control_request', request_id, request }, `control:${request.subtype}`);
    return { t, request_id, response: p };
  }

  // Resolves with the first event (index >= from) matching pred, or null after timeoutMs.
  waitFor(pred, { from = 0, timeoutMs = 60000 } = {}) {
    for (let i = from; i < this.events.length; i++) if (pred(this.events[i].ev, this.events[i])) return Promise.resolve(this.events[i]);
    return new Promise(resolve => {
      const onLine = rec => { if (pred(rec.ev, rec)) { cleanup(); resolve(rec); } };
      const onExit = () => { cleanup(); resolve(null); };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.off('line', onLine); this.off('exit', onExit); };
      this.on('line', onLine);
      this.on('exit', onExit);
    });
  }

  waitResult(opts) { return this.waitFor(ev => ev.type === 'result', opts); }

  closeStdin() { const t = this.now(); this.child.stdin.end(); return t; }

  async kill(graceMs = 3000) {
    if (this.exit) return this.exit;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => { try { this.child.kill(); } catch { /* gone */ } }, graceMs);
    const e = await this.exited;
    clearTimeout(timer);
    return e;
  }

  // Full stdout for manual inspection, only when SPIKE_RAW_DIR is set (kept out of results/).
  dumpRaw(name) {
    const dir = process.env.SPIKE_RAW_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.jsonl'), this.events.map(r => JSON.stringify({ t: +r.t.toFixed(1), ...r.ev })).join('\n'));
  }

  // Compact record for results/: labels + times, never full transcripts.
  sequence({ from = 0, collapseDeltas = true } = {}) {
    const out = [];
    for (const r of this.events.slice(from)) {
      const last = out[out.length - 1];
      if (collapseDeltas && last && last.label === r.label && r.label.startsWith('se:content_block_delta')) {
        last.n = (last.n || 1) + 1;
        last.tEnd = +r.t.toFixed(1);
        continue;
      }
      out.push({ t: +r.t.toFixed(1), label: r.label });
    }
    return out;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = xs => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const stats = xs => {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x));
  return { n: v.length, median: v.length ? +median(v).toFixed(1) : null, min: v.length ? +Math.min(...v).toFixed(1) : null, max: v.length ? +Math.max(...v).toFixed(1) : null };
};

function saveResult(name, data) {
  const dir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ name, claudeVersion: process.env.CLAUDE_VERSION || null, at: new Date().toISOString(), ...data }, null, 2));
  return file;
}

module.exports = { ClaudeStreamClient, label, textOf, resolveClaudeBin, sleep, stats, median, saveResult, SPIKE_CWD };
