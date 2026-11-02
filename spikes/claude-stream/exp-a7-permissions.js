// A7: permission prompts over stdio (can_use_tool), allow/deny shapes, PermissionRequest hook order,
// and what happens without a permission tool.
//   node exp-a7-permissions.js [cases=modes,allow,deny,deny-interrupt,none,oneshot]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ClaudeStreamClient, saveResult, resolveClaudeBin, SPIKE_CWD } = require('./lib/client');
const { writeSettings, readLog } = require('./lib/hooks');

const DENY_MSG = 'The user declined this by voice. Do not retry the command. Reply exactly: DENIED-OK';

function hookTimeline(c, log) {
  const stream = c.events.filter(r => r.ev.type === 'system' && /^hook_/.test(r.ev.subtype) && r.ev.hook_event !== 'SessionStart')
    .map(r => ({ t: +r.t.toFixed(1), src: 'stream', what: `${r.ev.subtype}:${r.ev.hook_name}`, outcome: r.ev.outcome }));
  const ctl = c.events.filter(r => r.ev.type === 'control_request').map(r => ({ t: +r.t.toFixed(1), src: 'stream', what: `control_request:${r.ev.request.subtype}` }));
  const tool = c.events.filter(r => r.ev.type === 'user' && JSON.stringify(r.ev.message).includes('tool_result')).map(r => ({ t: +r.t.toFixed(1), src: 'stream', what: 'tool_result' }));
  const probe = readLog(log, c.wall0).map(r => ({ t: r.tRel, src: 'probe-hook', what: `${r.event}:${r.tool || ''}` }));
  return [...stream, ...ctl, ...tool, ...probe].sort((a, b) => a.t - b.t);
}

async function runCase(name, { decide, permissionPromptTool = 'stdio', permissionMode = 'default', i = 0 }) {
  const file = `perm-${name}-${Date.now()}-${i}.txt`;
  const { file: settings, log } = writeSettings(`a7-${name}`, {
    PreToolUse: [{ matcher: 'Bash', mode: 'log' }],
    PermissionRequest: [{ mode: 'log' }],
  });
  const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 4, permissionMode, permissionPromptTool, settings, extraArgs: ['--include-hook-events'], env: { SPIKE_HOOK_LOG: log } }).start();
  const requests = [];
  c.onControlRequest = (ev, t) => {
    const r = ev.request;
    requests.push({ t: +t.toFixed(1), subtype: r.subtype, tool_name: r.tool_name, input: r.input, keys: Object.keys(r), topKeys: Object.keys(ev), permission_suggestions: r.permission_suggestions, decision_reason: r.decision_reason, decision_reason_type: r.decision_reason_type });
    return decide ? decide(ev) : null;
  };
  const tw = c.sendUser(`Use the Bash tool to run exactly this command: touch ${file}\nThen reply DONE.`);
  const res = await c.waitFor(ev => ev.type === 'result', { timeoutMs: decide ? 90000 : 45000 });
  const tr = c.events.find(r => r.ev.type === 'user' && JSON.stringify(r.ev.message).includes('tool_result'));
  const init = c.events.find(r => r.ev.type === 'system' && r.ev.subtype === 'init');
  const out = {
    case: name, rep: i, permissionMode, permissionPromptTool,
    initPermissionMode: init && init.ev.permissionMode,
    interactiveToolsInInit: init ? ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'].filter(t => init.ev.tools.includes(t)) : null,
    requests,
    responsesWritten: c.writes.filter(w => w.kind === 'control_response').map(w => w.obj),
    fileCreated: fs.existsSync(path.join(SPIKE_CWD, file)),
    toolResult: tr ? { content: JSON.stringify(tr.ev.message.content[0].content).slice(0, 200), is_error: tr.ev.message.content[0].is_error } : null,
    result: res ? { subtype: res.ev.subtype, terminal_reason: res.ev.terminal_reason, text: String(res.ev.result).slice(0, 120), permission_denials: res.ev.permission_denials, t: +(res.t - tw).toFixed(1) } : 'timeout',
    timeline: hookTimeline(c, log),
    stderr: c.stderr.slice(0, 300),
  };
  c.dumpRaw(`a7-${name}-${i}`);
  await c.kill();
  console.log(name, i, 'requests', requests.map(r => `${r.subtype}:${r.tool_name}`).join(','), 'file', out.fileCreated, 'result', JSON.stringify(out.result).slice(0, 300));
  console.log('  timeline', out.timeline.map(x => `${x.t} ${x.src} ${x.what}${x.outcome ? '(' + x.outcome + ')' : ''}`).join(' | '));
  return out;
}

async function modes() {
  const out = [];
  for (const m of ['default', 'manual', 'auto']) {
    const c = new ClaudeStreamClient({ model: 'haiku', maxTurns: 1, permissionMode: m }).start();
    c.sendUser('Reply with exactly: OK');
    const res = await c.waitFor(ev => ev.type === 'result', { timeoutMs: 45000 });
    const init = c.events.find(r => r.ev.type === 'system' && r.ev.subtype === 'init');
    out.push({ flag: m, initPermissionMode: init && init.ev.permissionMode, interactiveToolsInInit: init ? ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'].filter(t => init.ev.tools.includes(t)) : null, result: res && res.ev.result, stderr: c.stderr.slice(0, 200), exit: c.exit });
    await c.kill();
    console.log('mode', JSON.stringify(out[out.length - 1]));
  }
  return out;
}

// Plain one-shot `claude -p "..."` (text in, json out), default mode, no permission tool.
function oneshot() {
  const file = `perm-oneshot-${Date.now()}.txt`;
  const r = spawnSync(resolveClaudeBin(), ['-p', `Use the Bash tool to run exactly this command: touch ${file}\nThen reply DONE.`, '--model', 'haiku', '--max-turns', '3', '--permission-mode', 'default', '--output-format', 'json'], { cwd: SPIKE_CWD, env: { ...process.env, AGENTCALL_SESSION_MODE: 'off' }, encoding: 'utf8', timeout: 120000, windowsHide: true });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* not json */ }
  const out = { exit: r.status, fileCreated: fs.existsSync(path.join(SPIKE_CWD, file)), result: j && String(j.result).slice(0, 200), permission_denials: j && j.permission_denials, terminal_reason: j && j.terminal_reason, stderr: (r.stderr || '').slice(0, 200) };
  console.log('oneshot', JSON.stringify(out));
  return out;
}

async function main() {
  const cases = (process.argv[2] || 'modes,allow,deny,deny-interrupt,none,oneshot').split(',');
  const out = {};
  if (cases.includes('modes')) out.modes = await modes();
  const allow = ev => ({ behavior: 'allow', updatedInput: ev.request.input });
  if (cases.includes('allow')) out.allow = [await runCase('allow', { decide: allow, i: 0 }), await runCase('allow', { decide: allow, i: 1 })];
  if (cases.includes('deny')) out.deny = [await runCase('deny', { decide: () => ({ behavior: 'deny', message: DENY_MSG }), i: 0 }), await runCase('deny', { decide: () => ({ behavior: 'deny', message: DENY_MSG }), i: 1 })];
  if (cases.includes('deny-interrupt')) out.denyInterrupt = [await runCase('deny-interrupt', { decide: () => ({ behavior: 'deny', message: 'The user stopped this by voice.', interrupt: true }) })];
  // No --permission-prompt-tool: does the CLI still ask the stdio host? (answered allow, to see it)
  if (cases.includes('none')) out.none = [await runCase('none', { decide: allow, permissionPromptTool: null })];
  if (cases.includes('oneshot')) out.oneshot = oneshot();
  console.log('saved', saveResult('a7-permissions', out));
}
main().catch(e => { console.error(e); process.exit(1); });
