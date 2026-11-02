// Builds --settings files with test command hooks (hooks/probe-hook.js) and reads their call log.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { SPIKE_CWD } = require('./client');

const HOOK = path.join(__dirname, '..', 'hooks', 'probe-hook.js');
const WORK = path.join(SPIKE_CWD, '.spike'); // inside the scratch repo, git-excluded

// spec: { EventName: [{ matcher?, mode, text?, extra?, async?, asyncRewake?, timeout? }] }
function writeSettings(name, spec) {
  fs.mkdirSync(WORK, { recursive: true });
  const hooks = {};
  for (const [event, entries] of Object.entries(spec)) {
    hooks[event] = entries.map(e => {
      const h = { type: 'command', command: 'node', args: [HOOK, e.mode, ...(e.text != null ? [String(e.text)] : []), ...(e.extra || [])], timeout: e.timeout || 30 };
      if (e.async) h.async = true;
      if (e.asyncRewake) h.asyncRewake = true;
      return { ...(e.matcher ? { matcher: e.matcher } : {}), hooks: [h] };
    });
  }
  const file = path.join(WORK, `settings-${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2));
  const log = path.join(WORK, `hooklog-${name}-${Date.now()}.jsonl`);
  return { file, log };
}

function readLog(log, wall0 = 0) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => ({ ...r, tRel: wall0 ? r.t - wall0 : undefined }));
}

module.exports = { writeSettings, readLog, HOOK, WORK };
