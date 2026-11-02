// A1 auth/init fields + A2 several user messages over one process (session id, startup and turn latency).
//   node exp-a1-a2-basic.js [reps=3]
'use strict';
const { ClaudeStreamClient, stats, saveResult, textOf } = require('./lib/client');

const isTextDelta = ev => ev.type === 'stream_event' && ev.event.type === 'content_block_delta' && ev.event.delta.type === 'text_delta';

async function turn(c, text) {
  const from = c.events.length;
  const tw = c.sendUser(text);
  const res = await c.waitFor(ev => ev.type === 'result', { from, timeoutMs: 120000 });
  const after = c.events.slice(from);
  const first = after[0];
  const at = pred => { const r = after.find(x => pred(x.ev)); return r ? +(r.t - tw).toFixed(1) : null; };
  return {
    writeToFirstLine: first ? +(first.t - tw).toFixed(1) : null,
    firstLabel: first && first.label,
    writeToInit: at(ev => ev.type === 'system' && ev.subtype === 'init'),
    writeToStatusRequesting: at(ev => ev.type === 'system' && ev.subtype === 'status'),
    writeToMessageStart: at(ev => ev.type === 'stream_event' && ev.event.type === 'message_start'),
    writeToFirstTextDelta: at(isTextDelta),
    writeToResult: res ? +(res.t - tw).toFixed(1) : null,
    resultSubtype: res && res.ev.subtype,
    resultText: res && String(res.ev.result).slice(0, 40),
    resultFields: res ? { ttft_ms: res.ev.ttft_ms, duration_ms: res.ev.duration_ms, num_turns: res.ev.num_turns, terminal_reason: res.ev.terminal_reason, result_index: res.ev.result_index, queued_turn_count: res.ev.queued_turn_count } : null,
    sessionIds: [...new Set(after.map(r => r.ev.session_id).filter(Boolean))],
    sequence: c.sequence({ from }).map(s => s.label + (s.n ? ' x' + s.n : '')),
  };
}

async function run(mode, i) {
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 3 }).start();
  const out = { mode, rep: i };
  if (mode === 'initialize-first') {
    const r = c.control({ subtype: 'initialize' });
    const resp = await r.response;
    out.spawnToInitializeResponse = resp ? +resp.t.toFixed(1) : null;
    if (resp && i === 0) {
      const body = resp.ev.response.response || {};
      out.initializeResponseKeys = Object.keys(body);
      out.account = body.account ? { subscriptionType: body.account.subscriptionType, apiProvider: body.account.apiProvider, hasEmail: Boolean(body.account.email) } : null;
      out.initializeCapabilities = body.capabilities;
      out.current_permission_mode = body.current_permission_mode;
    }
  }
  const turns = [];
  turns.push(await turn(c, 'Reply with exactly: ONE'));
  turns.push(await turn(c, 'Reply with exactly: TWO'));
  turns.push(await turn(c, 'Reply with exactly: THREE'));
  const init = c.events.find(r => r.ev.type === 'system' && r.ev.subtype === 'init');
  out.spawnToSystemInit = init ? +init.t.toFixed(1) : null;
  out.firstWriteAt = +c.writes.find(w => w.kind === 'user').t.toFixed(1);
  out.initCount = c.events.filter(r => r.ev.type === 'system' && r.ev.subtype === 'init').length;
  out.sameSessionAcrossTurns = new Set(turns.flatMap(t => t.sessionIds)).size === 1;
  out.sessionId = c.sessionId;
  if (init && i === 0) {
    const e = init.ev;
    out.init = {
      apiKeySource: e.apiKeySource, model: e.model, permissionMode: e.permissionMode, cwd: e.cwd,
      claude_code_version: e.claude_code_version, output_style: e.output_style, capabilities: e.capabilities,
      counts: { tools: e.tools.length, mcpTools: e.tools.filter(t => t.startsWith('mcp__')).length, slash_commands: e.slash_commands.length, skills: (e.skills || []).length, agents: (e.agents || []).length, plugins: (e.plugins || []).length, mcp_servers: e.mcp_servers.length },
      keys: Object.keys(e),
    };
  }
  out.envHasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  out.turns = turns;
  out.texts = turns.map(t => t.resultText);
  out.stderr = c.stderr.slice(0, 300);
  const tc = c.closeStdin();
  const ex = await c.exited;
  out.stdinCloseToExit = +(ex.t - tc).toFixed(1);
  out.exit = { code: ex.code, signal: ex.signal };
  void textOf;
  return out;
}

async function main() {
  const reps = +(process.argv[2] || 3);
  const runs = [];
  for (const mode of ['initialize-first', 'message-first']) {
    for (let i = 0; i < reps; i++) {
      const r = await run(mode, i);
      console.log(mode, i, 'init@', r.spawnToSystemInit, 'turns', r.turns.map(t => `${t.writeToFirstTextDelta}/${t.writeToResult}`).join(' '), r.texts.join(','), 'sameSession', r.sameSessionAcrossTurns);
      runs.push(r);
    }
  }
  const pick = (mode, k, ti) => runs.filter(r => r.mode === mode).map(r => ti == null ? r[k] : r.turns[ti][k]);
  const summary = {
    spawnToInitializeResponse: stats(pick('initialize-first', 'spawnToInitializeResponse')),
    spawnToSystemInit_initFirst: stats(pick('initialize-first', 'spawnToSystemInit')),
    spawnToSystemInit_messageFirst: stats(pick('message-first', 'spawnToSystemInit')),
    firstTurn_writeToFirstTextDelta_messageFirst: stats(pick('message-first', 'writeToFirstTextDelta', 0)),
    firstTurn_writeToResult_messageFirst: stats(pick('message-first', 'writeToResult', 0)),
    firstTurn_writeToFirstTextDelta_initFirst: stats(pick('initialize-first', 'writeToFirstTextDelta', 0)),
    warmTurns_writeToFirstLine: stats(runs.flatMap(r => r.turns.slice(1).map(t => t.writeToFirstLine))),
    warmTurns_writeToMessageStart: stats(runs.flatMap(r => r.turns.slice(1).map(t => t.writeToMessageStart))),
    warmTurns_writeToFirstTextDelta: stats(runs.flatMap(r => r.turns.slice(1).map(t => t.writeToFirstTextDelta))),
    warmTurns_writeToResult: stats(runs.flatMap(r => r.turns.slice(1).map(t => t.writeToResult))),
    stdinCloseToExit: stats(runs.map(r => r.stdinCloseToExit)),
    allSameSession: runs.every(r => r.sameSessionAcrossTurns),
    allCorrect: runs.every(r => r.texts.join(',') === 'ONE,TWO,THREE'),
  };
  console.log(JSON.stringify(summary, null, 1));
  console.log('saved', saveResult('a1-a2-basic', { summary, runs }));
}
main().catch(e => { console.error(e); process.exit(1); });
