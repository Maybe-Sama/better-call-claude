// Test command hook for the spike: logs every call (Date.now) to $SPIKE_HOOK_LOG and answers by mode.
//   node probe-hook.js <mode> [text]
// modes: log | post-context | pre-deny | pre-context | stop-context | batch-context | post-block | rewake <ms>
'use strict';
const fs = require('node:fs');

async function main() {
  const [mode, a1, a2] = process.argv.slice(2);
  const t = Date.now();
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let p = {};
  try { p = JSON.parse(input); } catch { /* keep {} */ }
  const log = rec => { if (process.env.SPIKE_HOOK_LOG) fs.appendFileSync(process.env.SPIKE_HOOK_LOG, JSON.stringify(rec) + '\n'); };
  log({ t, mode, event: p.hook_event_name, tool: p.tool_name, tool_use_id: p.tool_use_id, stop_hook_active: p.stop_hook_active, source: p.source, keys: Object.keys(p), delta: p.delta && p.delta.slice(0, 40), final: p.final });
  const out = o => process.stdout.write(JSON.stringify(o));
  switch (mode) {
    case 'post-context':
      return out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: a1 } });
    case 'pre-context':
      return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: a1 } });
    case 'pre-deny':
      return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: a1 } });
    case 'batch-context':
      return out({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: a1 } });
    case 'post-block':
      return out({ decision: 'block', reason: a1 });
    case 'stop-context':
      // Only once per turn: a second Stop (stop_hook_active) must be allowed to end the turn.
      if (p.stop_hook_active) return;
      return out({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: a1 } });
    case 'stop-block':
      if (p.stop_hook_active) return;
      return out({ decision: 'block', reason: a1 });
    case 'rewake': {
      // asyncRewake: run in the background, then wake the model with exit code 2 + stderr.
      await new Promise(r => setTimeout(r, +a1 || 5000));
      log({ t: Date.now(), mode: 'rewake-fire', event: p.hook_event_name });
      process.stderr.write(a2 || 'Voice message from the user.');
      process.exitCode = 2;
      return;
    }
    default:
      return; // log only
  }
}
main().catch(() => {});
