const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchTarget, startAgentCall } = require('../claude-plugin/hooks/agentcall-hook.js');

function withLocalAppData(t, launchJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcall-hook-'));
  fs.mkdirSync(path.join(dir, 'AgentCall'));
  if (launchJson !== undefined) fs.writeFileSync(path.join(dir, 'AgentCall', 'launch.json'), launchJson);
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = dir;
  t.after(() => {
    process.env.LOCALAPPDATA = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('launchTarget uses the copy recorded in launch.json', t => {
  const dir = withLocalAppData(t);
  const appDir = path.join(dir, 'fake-app');
  const electron = path.join(appDir, 'electron.exe');
  fs.mkdirSync(appDir);
  fs.writeFileSync(electron, '');
  fs.writeFileSync(path.join(appDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'AgentCall', 'launch.json'), JSON.stringify({ electron, appDir }));

  assert.deepEqual(launchTarget(), { electron, appDir });
});

test('launchTarget ignores a malformed launch.json instead of throwing', t => {
  for (const bad of ['{"electron": 123, "appDir": {}}', '{"electron": ["a"], "appDir": "x"}', 'null', 'not json']) {
    withLocalAppData(t, bad);
    let target;
    assert.doesNotThrow(() => { target = launchTarget(); }, bad);
    // Falls back to the copy next to the plugin (or none), never to the malformed entry.
    if (target) {
      assert.equal(typeof target.electron, 'string', bad);
      assert.equal(typeof target.appDir, 'string', bad);
    }
  }
});

test('startAgentCall reports a launch failure instead of crashing the hook', async () => {
  const missing = path.join(os.tmpdir(), 'agentcall-no-such-dir', 'electron.exe');
  const started = Date.now();
  const ok = await startAgentCall({ electron: missing, appDir: path.dirname(missing) }, 3000);
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 2000, 'gives up as soon as the spawn fails');
});
