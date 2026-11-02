// Exploration helper: one session, a script of steps, full stdout dumped to a file OUTSIDE results/
// (full transcripts are not kept in the repo).
//   node raw.js <out.jsonl> '<steps json>' [model]
// steps: [{"user":"text"} | {"control":{"subtype":"initialize"}} | {"wait":"result"|ms} | {"close":true}]
'use strict';
const fs = require('node:fs');
const { ClaudeStreamClient, sleep } = require('./lib/client');

async function main() {
  const [out, stepsJson, model = 'haiku', ...extra] = process.argv.slice(2);
  const steps = JSON.parse(stepsJson);
  const c = new ClaudeStreamClient({ model, extraArgs: extra, maxTurns: 6 }).start();
  c.onControlRequest = req => {
    console.error('CLI control_request', JSON.stringify(req).slice(0, 400));
    return { behavior: 'allow', updatedInput: req.request.input };
  };
  let results = 0;
  for (const s of steps) {
    if (s.user) c.sendUser(s.user);
    else if (s.control) { const r = c.control(s.control); const resp = await r.response; console.error('control resp', JSON.stringify(resp && resp.ev).slice(0, 2000)); }
    else if (s.wait === 'result') { const want = ++results; await c.waitFor((ev, rec) => ev.type === 'result' && c.events.filter(r => r.ev.type === 'result').indexOf(rec) === want - 1, { from: 0, timeoutMs: 120000 }); }
    else if (typeof s.wait === 'number') await sleep(s.wait);
    else if (s.close) c.closeStdin();
  }
  c.closeStdin();
  const exit = await Promise.race([c.exited, new Promise(r => setTimeout(r, 20000).unref()).then(() => null)]);
  if (!exit) await c.kill();
  fs.writeFileSync(out, c.events.map(r => JSON.stringify({ t: +r.t.toFixed(1), ...r.ev })).join('\n'));
  console.error('exit', JSON.stringify(c.exit), 'stderr:', c.stderr.slice(0, 1000));
  console.error(c.sequence().map(s => `${s.t}\t${s.label}${s.n ? ' x' + s.n : ''}`).join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
