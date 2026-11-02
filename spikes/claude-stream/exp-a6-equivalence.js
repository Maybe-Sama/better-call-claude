// A6: does a stream-json session load what normal Claude Code loads? Init inventory vs the user's
// config, CLAUDE.md (project + user) applied, MCP status after startup, stream-json vs plain -p.
//   node exp-a6-equivalence.js            (default model from the user's settings)
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ClaudeStreamClient, sleep, saveResult, resolveClaudeBin, SPIKE_CWD } = require('./lib/client');

function initSummary(e) {
  return {
    model: e.model, permissionMode: e.permissionMode, cwd: e.cwd, output_style: e.output_style, apiKeySource: e.apiKeySource,
    builtinTools: e.tools.filter(t => !t.startsWith('mcp__')),
    mcpToolCount: e.tools.filter(t => t.startsWith('mcp__')).length,
    mcp_servers: e.mcp_servers,
    plugins: (e.plugins || []).map(p => p.source || p.name),
    skills: e.skills, agents: e.agents,
    slashCommandCount: e.slash_commands.length,
    terminal_slash_commands: e.terminal_slash_commands,
  };
}

function userConfig() {
  const home = os.homedir();
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  let claudeJson = {};
  try { claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')); } catch { /* absent */ }
  const skillsDir = path.join(home, '.claude', 'skills');
  return {
    enabledPlugins: Object.keys(settings.enabledPlugins || {}).filter(k => settings.enabledPlugins[k]),
    settingsModel: settings.model, settingsDefaultMode: settings.permissions && settings.permissions.defaultMode,
    userHookEvents: Object.keys(settings.hooks || {}),
    userMcpServers: Object.keys(claudeJson.mcpServers || {}),
    userSkillDirs: fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).filter(d => fs.existsSync(path.join(skillsDir, d, 'SKILL.md'))) : [],
  };
}

async function main() {
  const out = { config: userConfig() };
  // 1. stream-json session, default model (no --model): what loads, does CLAUDE.md apply?
  const c = new ClaudeStreamClient({ maxTurns: 1 }).start();
  const tw = c.sendUser('Do not use any tools. Answer in exactly two lines. Line 1: the project codeword from the project instructions, or NONE. Line 2: the name of the skill that your global user instructions say to run after producing any artifact, or NONE.');
  const res = await c.waitFor(ev => ev.type === 'result', { timeoutMs: 180000 });
  const init = c.events.find(r => r.ev.type === 'system' && r.ev.subtype === 'init');
  out.stream = initSummary(init.ev);
  out.answer = res && res.ev.result;
  out.answerTimeMs = res ? +(res.t - tw).toFixed(0) : null;
  out.costUsd = res && res.ev.total_cost_usd;
  out.hooksSeenAtStart = c.events.filter(r => r.ev.type === 'system' && r.ev.subtype === 'hook_response').map(r => `${r.ev.hook_name}:${r.ev.outcome}`);
  await sleep(8000);
  const mcp = c.control({ subtype: 'mcp_status' });
  const mresp = await mcp.response;
  out.mcpStatusAfterTurn = mresp ? (mresp.ev.response.response || mresp.ev.response).mcpServers?.map(s => `${s.name}:${s.status}`) || mresp.ev.response : null;
  c.dumpRaw('a6-default');
  await c.kill();
  console.log('answer', JSON.stringify(out.answer), 'model', out.stream.model, 'mcp', JSON.stringify(out.mcpStatusAfterTurn));

  // 2. Plain one-shot -p (text input) with stream-json output: same inventory?
  const r = spawnSync(resolveClaudeBin(), ['-p', 'Reply with exactly: OK', '--model', 'haiku', '--max-turns', '1', '--output-format', 'stream-json', '--verbose'], { cwd: SPIKE_CWD, env: { ...process.env, AGENTCALL_SESSION_MODE: 'off' }, encoding: 'utf8', timeout: 120000, windowsHide: true });
  const plainInit = r.stdout.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }).find(e => e.type === 'system' && e.subtype === 'init');
  const p = plainInit ? initSummary(plainInit) : null;
  out.plainPrint = p ? {
    sameBuiltinTools: JSON.stringify(p.builtinTools) === JSON.stringify(out.stream.builtinTools),
    builtinToolsOnlyInStream: out.stream.builtinTools.filter(t => !p.builtinTools.includes(t)),
    builtinToolsOnlyInPlain: p.builtinTools.filter(t => !out.stream.builtinTools.includes(t)),
    samePlugins: JSON.stringify(p.plugins) === JSON.stringify(out.stream.plugins),
    sameSkills: JSON.stringify(p.skills) === JSON.stringify(out.stream.skills),
    mcpServers: p.mcp_servers.map(s => s.name),
  } : { error: r.stderr.slice(0, 200) };
  out.comparison = {
    enabledPluginsLoaded: out.config.enabledPlugins.filter(x => out.stream.plugins.includes(x)),
    enabledPluginsMissing: out.config.enabledPlugins.filter(x => !out.stream.plugins.includes(x)),
    extraPlugins: out.stream.plugins.filter(x => !out.config.enabledPlugins.includes(x)),
    userMcpLoaded: out.config.userMcpServers.filter(x => out.stream.mcp_servers.some(s => s.name === x)),
    userMcpMissing: out.config.userMcpServers.filter(x => !out.stream.mcp_servers.some(s => s.name === x)),
    userSkillsMissing: out.config.userSkillDirs.filter(x => !(out.stream.skills || []).includes(x)),
    interactiveOnlyToolsAbsent: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'].filter(t => !out.stream.builtinTools.includes(t)),
  };
  console.log(JSON.stringify(out.comparison), JSON.stringify(out.plainPrint));
  console.log('saved', saveResult('a6-equivalence', out));
}
main().catch(e => { console.error(e); process.exit(1); });
