const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { StreamSession, resolveClaude, parsePs, linkTree, sameProcess } = require('../src/voice/stream-session');

// Capabilities Claude Code 2.1.289 announces in system/init (docs/spikes/claude-stream-json.md).
const CAPS = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'interrupt_send_now_v1', 'msg_lifecycle_v1'];
const tick = () => new Promise(resolve => setImmediate(resolve));

// A fake `claude` child (stdin/stdout/stderr streams + events), fake timers and a fake tree killer.
function harness(options = {}) {
  let now = 1000;
  let seq = 0;
  const timers = new Map();
  const spawned = [];
  const kills = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4321;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.written = '';
    child.stdinEnded = false;
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', d => { child.written += d; });
    child.stdin.on('finish', () => { child.stdinEnded = true; });
    const emit = child.emit.bind(child);
    child.emit = (event, ...args) => {
      const r = emit(event, ...args);
      if (event === 'exit' && options.autoClose !== false) emit('close', ...args);
      return r;
    };
    spawned.push({ cmd, args, opts, child });
    return child;
  };
  const session = new StreamSession({
    cwd: 'E:\\work\\repo',
    claudePath: 'C:\\tools\\claude.exe',
    spawn,
    env: { PATH: 'C:\\tools', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '9', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe' },
    now: () => now,
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { at: now + ms, fn }); return seq; },
    clearTimer: id => timers.delete(id),
    killTree: (pid) => kills.push(pid),
    listTree: async () => [],
    findLeftovers: async () => [],
    ...options,
  });
  const out = [];
  for (const name of ['turn-start', 'text', 'tool', 'assistant-start', 'assistant-message', 'turn-end', 'message', 'permission', 'permission-cancelled', 'exit', 'error', 'debug']) {
    session.on(name, data => out.push({ ev: name, ...(data instanceof Error ? { message: data.message } : typeof data === 'string' ? { message: data } : data) }));
  }
  const child = () => spawned[0].child;
  const emit = obj => child().stdout.write(JSON.stringify(obj) + '\n');
  const writes = () => child().written.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    now = end;
  };
  const events = name => out.filter(o => o.ev === name);
  // start() → answer the initialize request the session writes.
  const ready = async () => {
    const started = session.start();
    await tick();
    const init = writes().find(w => w.type === 'control_request' && w.request.subtype === 'initialize');
    emit({ type: 'control_response', response: { subtype: 'success', request_id: init.request_id, response: { pid: 4321, capabilities: ['ui_surface_v1'] } } });
    await started;
  };
  const sysInit = (extra = {}) => emit({ type: 'system', subtype: 'init', session_id: session.sessionId, model: 'claude-haiku-4-5', permissionMode: 'default', capabilities: CAPS, claude_code_version: '2.1.289', ...extra });
  const se = (event, parent = null) => emit({ type: 'stream_event', event, parent_tool_use_id: parent, session_id: session.sessionId });
  return { session, spawned, kills, out, events, child, emit, writes, advance, ready, sysInit, se, timers };
}

// ── Spawn ────────────────────────────────────────────────────────────────

test('start: spawns claude -p stream-json with stdio permissions and a fresh session id', async () => {
  const h = harness();
  await h.ready();
  const { cmd, args, opts } = h.spawned[0];
  assert.equal(cmd, 'C:\\tools\\claude.exe');
  assert.deepEqual(args.slice(0, 11), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--session-id']);
  assert.match(args[11], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(h.session.sessionId, args[11]);
  assert.ok(!args.includes('--resume') && !args.includes('--model'));
  assert.equal(opts.cwd, 'E:\\work\\repo');
  assert.equal(opts.windowsHide, true);
});

test('start: the child env turns AgentCall hooks off and drops the parent Claude session variables', async () => {
  const h = harness();
  await h.ready();
  const { env } = h.spawned[0].opts;
  assert.equal(env.AGENTCALL_SESSION_MODE, 'off');
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID']) assert.equal(env[name], undefined, name);
  assert.equal(env.PATH, 'C:\\tools');
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\git\\bash.exe', 'user configuration stays');
  // Every variable Claude Code sets for its children, in any case (Windows names are case-insensitive).
  const parent = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID',
    'CLAUDE_EFFORT', 'AI_AGENT', 'TRACEPARENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'Claude_Code_Messaging_Token'];
  const all = harness({ env: { ...Object.fromEntries(parent.map(n => [n, 'x'])), Path: 'C:\\bin', ANTHROPIC_MODEL: 'kept' } });
  await all.ready();
  const childEnv = all.spawned[0].opts.env;
  assert.deepEqual(Object.keys(childEnv).sort(), ['ANTHROPIC_MODEL', 'AGENTCALL_SESSION_MODE', 'Path'].sort());
});

test('start: --resume keeps the given id, --session-id and --model are honoured', async () => {
  const a = harness({ resume: 'aaaaaaaa-1111-4111-8111-111111111111', model: 'haiku' });
  await a.ready();
  const argsA = a.spawned[0].args;
  assert.deepEqual(argsA.slice(argsA.indexOf('--resume'), argsA.indexOf('--resume') + 2), ['--resume', 'aaaaaaaa-1111-4111-8111-111111111111']);
  assert.ok(!argsA.includes('--session-id'));
  assert.deepEqual(argsA.slice(argsA.indexOf('--model'), argsA.indexOf('--model') + 2), ['--model', 'haiku']);
  assert.equal(a.session.sessionId, 'aaaaaaaa-1111-4111-8111-111111111111');
  const b = harness({ sessionId: 'bbbbbbbb-2222-4222-8222-222222222222' });
  await b.ready();
  assert.equal(b.spawned[0].args[b.spawned[0].args.indexOf('--session-id') + 1], 'bbbbbbbb-2222-4222-8222-222222222222');
});

test('start: --append-system-prompt carries the call rules, as one argument', async () => {
  const rules = 'Line one.\n- "quoted" rule';
  const h = harness({ appendSystemPrompt: rules });
  await h.ready();
  const { args } = h.spawned[0];
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], rules);
  const plain = harness();
  await plain.ready();
  assert.ok(!plain.spawned[0].args.includes('--append-system-prompt'));
});

test('start: resolves on the initialize answer; the first system/init gives model and capabilities', async () => {
  const h = harness();
  await h.ready();
  assert.equal(h.session.capabilities, null, 'Claude Code only announces them when a turn starts');
  assert.equal(h.session.idle, true);
  h.session.send('hola');
  h.sysInit();
  await tick();
  assert.equal(h.session.model, 'claude-haiku-4-5');
  assert.deepEqual(h.session.capabilities, CAPS);
  assert.equal(h.events('error').length, 0);
});

test('start: rejects and kills the process when Claude Code does not answer within 30 s', async () => {
  const h = harness();
  const started = h.session.start();
  await tick();
  h.advance(29_000);
  assert.equal(h.kills.length, 0);
  h.advance(1_000);
  await assert.rejects(started, /30 s/);
  assert.deepEqual(h.kills, [4321]);
  assert.throws(() => h.session.send('hola'), /closed/, 'a session that never started takes no messages');
});

test('start: rejects when Claude Code exits first, with its stderr', async () => {
  const h = harness();
  const started = h.session.start();
  await tick();
  h.child().stderr.write('Error: not logged in\n');
  await tick();
  h.child().emit('exit', 1, null);
  await assert.rejects(started, /exited.*code 1.*not logged in/s);
});

test('a Claude Code without interrupt receipts or message lifecycle is refused at the first turn', async () => {
  for (const missing of ['msg_lifecycle_v1', 'interrupt_receipt_v1']) {
    const h = harness();
    await h.ready();
    h.session.send('hola');
    h.sysInit({ capabilities: CAPS.filter(c => c !== missing), claude_code_version: '2.0.1' });
    await tick();
    const [err] = h.events('error');
    assert.match(err.message, new RegExp(`Claude Code \\(2\\.0\\.1\\) does not support ${missing}`));
    assert.throws(() => h.session.send('otra'), /closed/);
  }
});

// ── Messages ─────────────────────────────────────────────────────────────

test('send: writes a user message with a fresh uuid; command_lifecycle becomes message events', async () => {
  const h = harness();
  await h.ready();
  const uuid = h.session.send('Arregla el login');
  const msg = h.writes().find(w => w.type === 'user');
  assert.deepEqual(msg, { type: 'user', message: { role: 'user', content: 'Arregla el login' }, parent_tool_use_id: null, session_id: h.session.sessionId, uuid });
  assert.equal(h.session.busy, true, 'Claude has work as soon as the message is written');
  const second = h.session.send('y los tests');
  assert.notEqual(second, uuid);
  for (const state of ['queued', 'started']) h.emit({ type: 'command_lifecycle', command_uuid: uuid, state });
  h.emit({ type: 'command_lifecycle', command_uuid: second, state: 'cancelled' });
  h.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' });
  await tick();
  assert.deepEqual(h.events('message').map(m => [m.uuid === uuid ? 'first' : 'second', m.state]),
    [['first', 'queued'], ['first', 'started'], ['second', 'cancelled'], ['first', 'completed']]);
  assert.equal(h.session.busy, true, 'the turn runs until its result');
  h.emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'ok' });
  await tick();
  assert.equal(h.session.busy, false);
  assert.equal(h.session.idle, true);
});

test('send: priority now only when the CLI announces send-now and no tool is running', async () => {
  const h = harness();
  await h.ready();
  const first = h.session.send('primera', { priority: 'now' });
  assert.equal(h.writes().at(-1).priority, undefined, 'capabilities unknown before the first turn');
  h.sysInit();
  h.emit({ type: 'command_lifecycle', command_uuid: first, state: 'started' });
  await tick();
  const second = h.session.send('segunda', { priority: 'now' });
  assert.equal(h.writes().at(-1).priority, 'now');
  h.emit({ type: 'command_lifecycle', command_uuid: second, state: 'started' });
  h.se({ type: 'message_start', message: { id: 'm1' } });
  h.se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash' } });
  await tick();
  const third = h.session.send('tercera', { priority: 'now' });
  assert.equal(h.writes().at(-1).priority, undefined, 'never preempt a running tool: it would be re-run');
  h.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, parent_tool_use_id: null });
  await tick();
  h.emit({ type: 'command_lifecycle', command_uuid: third, state: 'started' }); // folded in at the tool boundary
  await tick();
  h.session.send('cuarta', { priority: 'now' });
  assert.equal(h.writes().at(-1).priority, 'now', 'text again, nothing queued');
  h.session.send('quinta', { priority: 'now' });
  assert.equal(h.writes().at(-1).priority, undefined, 'cuarta has not started: a preemption could drop it');

  const old = harness();
  await old.ready();
  old.session.send('hola');
  old.sysInit({ capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'] });
  await tick();
  old.session.send('ya', { priority: 'now' });
  assert.equal(old.writes().at(-1).priority, undefined);
});

test('sendUrgent: interrupts the running turn, waits for it to end, then sends', async () => {
  const h = harness();
  await h.ready();
  h.session.send('Explícame todo');
  h.sysInit();
  await tick();
  const sent = h.session.sendUrgent('No, para: otra cosa');
  await tick();
  const interrupt = h.writes().find(w => w.type === 'control_request' && w.request.subtype === 'interrupt');
  assert.ok(interrupt, 'interrupt written');
  assert.equal(h.writes().filter(w => w.type === 'user').length, 1, 'nothing sent before the turn ends');
  h.emit({ type: 'control_response', response: { subtype: 'success', request_id: interrupt.request_id, response: { still_queued: [] } } });
  h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '' });
  const uuid = await sent;
  const last = h.writes().at(-1);
  assert.equal(last.message.content, 'No, para: otra cosa');
  assert.equal(last.uuid, uuid);
  assert.equal(last.priority, undefined);

  const idle = harness();
  await idle.ready();
  await idle.session.sendUrgent('hola');
  assert.equal(idle.writes().filter(w => w.type === 'control_request' && w.request.subtype === 'interrupt').length, 0, 'idle: no interrupt');
});

// ── Output parsing ───────────────────────────────────────────────────────

test('parser: partial lines, CRLF, non-JSON noise and unknown events are tolerated', async () => {
  const h = harness();
  await h.ready();
  h.session.send('hola');
  const line = JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null });
  const block = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null });
  const delta = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hola, ¿qué tal?' } }, parent_tool_use_id: null });
  const out = h.child().stdout;
  out.write('Warning: something on stdout\n');
  out.write(JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' }) + '\r\n');
  out.write(JSON.stringify({ type: 'something_new', x: 1 }) + '\n[1,2]\nnull\n');
  out.write(line.slice(0, 20));
  await tick();
  out.write(line.slice(20) + '\n' + block + '\n' + delta.slice(0, 101));
  await tick();
  out.write(delta.slice(101) + '\n');
  await tick();
  assert.deepEqual(h.events('text').map(t => t.delta), ['Hola, ¿qué tal?']);
  assert.equal(h.events('turn-start').length, 1);
  assert.equal(h.events('error').length, 0);
});

test('text: only top-level text blocks are speech, never thinking, tool input or subagent text', async () => {
  const h = harness();
  await h.ready();
  h.session.send('mira el repo');
  h.sysInit();
  h.se({ type: 'message_start', message: { id: 'm1' } });
  h.se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  h.se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pienso' } });
  h.se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } });
  h.se({ type: 'content_block_stop', index: 0 });
  h.se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  h.se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Voy a mirar.' } });
  h.se({ type: 'content_block_stop', index: 1 });
  h.se({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} } });
  h.se({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"prompt":"' } });
  h.se({ type: 'message_stop' });
  // The subagent streams its own message with the same indices.
  h.se({ type: 'message_start', message: { id: 's1' } }, 'toolu_1');
  h.se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, 'toolu_1');
  h.se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'texto del subagente' } }, 'toolu_1');
  h.se({ type: 'content_block_stop', index: 1 }, 'toolu_1');
  h.se({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'Grep' } }, 'toolu_1');
  h.se({ type: 'message_start', message: { id: 'm2' } });
  h.se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'sin bloque abierto' } });
  h.se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  h.se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Listo.' } });
  await tick();
  // A text block that ends is a finished paragraph: its last sentence can be spoken before the tool runs.
  assert.deepEqual(h.out.filter(o => o.ev === 'text' || o.ev === 'tool').map(o => (o.ev === 'tool' ? `tool:${o.name}` : o.delta)),
    ['Voy a mirar.', '\n\n', 'tool:Task', 'Listo.']);
  assert.deepEqual(h.events('tool').map(t => [t.name, t.toolUseId]), [['Task', 'toolu_1']]);
});

test('assistant-start: each top-level assistant message announces itself (one chunker per message)', async () => {
  const h = harness();
  await h.ready();
  h.session.send('mira y arregla');
  h.sysInit();
  h.se({ type: 'message_start', message: { id: 'm1' } });
  h.se({ type: 'message_start', message: { id: 's1' } }, 'toolu_1'); // a subagent's message: not ours
  h.se({ type: 'message_start', message: { id: 'm2' } });
  await tick();
  assert.deepEqual(h.events('assistant-start').map(e => e.messageId), ['m1', 'm2']);
  assert.ok(h.out.findIndex(o => o.ev === 'turn-start') < h.out.findIndex(o => o.ev === 'assistant-start'));
});

test('assistant-message: the full text at message_stop; a message cut by an interrupt is marked aborted', async () => {
  const h = harness();
  await h.ready();
  h.session.send('hola');
  h.sysInit();
  h.se({ type: 'message_start', message: { id: 'm1' } });
  h.se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
  h.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '' }] }, parent_tool_use_id: null });
  h.se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  h.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Primera parte.' }] }, parent_tool_use_id: null });
  h.emit({ type: 'assistant', message: { id: 'sub', content: [{ type: 'text', text: 'subagente' }] }, parent_tool_use_id: 'toolu_1' });
  h.se({ type: 'message_stop' });
  h.se({ type: 'message_start', message: { id: 'm2' } });
  h.se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  // Interrupt: the stream stops, but the partial block still arrives as an assistant event.
  h.emit({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Segunda a me' }] }, parent_tool_use_id: null });
  h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '' });
  await tick();
  assert.deepEqual(h.events('assistant-message').map(m => [m.text, m.aborted]), [['Primera parte.', false], ['Segunda a me', true]]);
});

test('turns: turn-start once per turn, turn-end from result with aborted from terminal_reason', async () => {
  const h = harness();
  await h.ready();
  const uno = h.session.send('uno');
  assert.equal(h.events('turn-start').length, 0);
  h.sysInit();
  h.emit({ type: 'command_lifecycle', command_uuid: uno, state: 'started' });
  h.se({ type: 'message_start', message: { id: 'm1' } });
  await tick();
  assert.equal(h.events('turn-start').length, 1);
  h.emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'UNO' });
  // A queued message runs as the next turn; a priority-now preemption reports success + aborted_streaming.
  h.sysInit();
  h.emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming', result: '' });
  h.sysInit();
  h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: '' });
  await tick();
  assert.equal(h.events('turn-start').length, 3);
  assert.deepEqual(h.events('turn-end').map(({ terminalReason, aborted, isError, result }) => ({ terminalReason, aborted, isError, result })), [
    { terminalReason: 'completed', aborted: false, isError: false, result: 'UNO' },
    { terminalReason: 'aborted_streaming', aborted: true, isError: false, result: '' },
    { terminalReason: 'aborted_tools', aborted: true, isError: true, result: '' },
  ]);
  assert.equal(h.session.busy, false);
});

// ── Control requests ─────────────────────────────────────────────────────

test('interrupt: resolves with the matching control_response, or null after 3 s', async () => {
  const h = harness();
  await h.ready();
  h.session.send('cuenta hasta 100');
  h.sysInit();
  const first = h.session.interrupt();
  const second = h.session.interrupt();
  const [a, b] = h.writes().filter(w => w.type === 'control_request' && w.request.subtype === 'interrupt');
  assert.notEqual(a.request_id, b.request_id);
  h.emit({ type: 'control_response', response: { subtype: 'success', request_id: b.request_id, response: { still_queued: ['x'] } } });
  assert.deepEqual(await second, { still_queued: ['x'] });
  h.advance(3000);
  assert.equal(await first, null);
});

test('permission: can_use_tool becomes a permission event; allow and deny write the stdio answers', async () => {
  const h = harness();
  await h.ready();
  h.session.send('crea el archivo');
  h.sysInit();
  const input = { file_path: 'E:\\work\\repo\\a.txt', content: 'hi' };
  h.emit({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input, description: 'Create a.txt', tool_use_id: 'toolu_7', permission_suggestions: [] } });
  h.emit({ type: 'control_request', request_id: 'cli-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' }, tool_use_id: 'toolu_8' } });
  h.emit({ type: 'control_request', request_id: 'cli-3', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git push' }, tool_use_id: 'toolu_9' } });
  await tick();
  assert.deepEqual(h.events('permission')[0], { ev: 'permission', requestId: 'cli-1', toolName: 'Write', input, description: 'Create a.txt', toolUseId: 'toolu_7' });
  h.session.allow('cli-1');
  h.session.deny('cli-2', 'El usuario no quiere.');
  h.session.deny('cli-3', 'Para.', { interrupt: true });
  const answers = h.writes().filter(w => w.type === 'control_response');
  assert.deepEqual(answers, [
    { type: 'control_response', response: { subtype: 'success', request_id: 'cli-1', response: { behavior: 'allow', updatedInput: input } } },
    { type: 'control_response', response: { subtype: 'success', request_id: 'cli-2', response: { behavior: 'deny', message: 'El usuario no quiere.' } } },
    { type: 'control_response', response: { subtype: 'success', request_id: 'cli-3', response: { behavior: 'deny', message: 'Para.', interrupt: true } } },
  ]);
});

test('permission: AskUserQuestion is answered by allow with the answers keyed by question text', async () => {
  const h = harness();
  await h.ready();
  const input = { questions: [{ question: '¿Qué base de datos?', header: 'DB', options: [{ label: 'Supabase', description: '' }, { label: 'Neon', description: '' }], multiSelect: false }] };
  h.emit({ type: 'control_request', request_id: 'cli-9', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: 'toolu_q' } });
  await tick();
  const [p] = h.events('permission');
  assert.equal(p.toolName, 'AskUserQuestion');
  h.session.allow(p.requestId, { ...p.input, answers: { '¿Qué base de datos?': 'Neon' } });
  assert.deepEqual(h.writes().at(-1).response.response, { behavior: 'allow', updatedInput: { ...input, answers: { '¿Qué base de datos?': 'Neon' } } });
});

test('control: a cancelled prompt is reported; unknown CLI requests get an error answer so it never waits', async () => {
  const h = harness();
  await h.ready();
  h.emit({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  h.emit({ type: 'control_cancel_request', request_id: 'cli-1' });
  h.emit({ type: 'control_request', request_id: 'cli-2', request: { subtype: 'hook_callback', callback_id: 'x' } });
  await tick();
  assert.deepEqual(h.events('permission-cancelled'), [{ ev: 'permission-cancelled', requestId: 'cli-1' }]);
  const answer = h.writes().at(-1);
  assert.equal(answer.type, 'control_response');
  assert.equal(answer.response.subtype, 'error');
  assert.equal(answer.response.request_id, 'cli-2');
});

test('robustness: a throwing listener or a malformed event becomes an error, never an exception out of stdout', async () => {
  const h = harness();
  await h.ready();
  h.session.once('turn-start', () => { throw new Error('consumer bug'); });
  h.session.send('hola');
  h.sysInit();
  h.emit({ type: 'user', message: { role: 'user', content: [null, { type: 'tool_result', tool_use_id: 'x' }] }, parent_tool_use_id: null });
  h.emit({ type: 'assistant', message: { id: null, content: [null] }, parent_tool_use_id: null });
  h.se({ type: 'content_block_start', index: 0, content_block: null });
  h.emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'ok' });
  await tick();
  assert.deepEqual(h.events('error').map(e => e.message), ['consumer bug']);
  assert.equal(h.events('turn-end').length, 1, 'parsing goes on');
});

test('robustness: a throwing raw listener does not stop the result from ending the turn', async () => {
  const h = harness();
  await h.ready();
  h.session.on('raw', ev => { if (ev.type === 'result') throw new Error('logger bug'); });
  const uuid = h.session.send('hola');
  h.sysInit();
  h.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
  h.emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'ok' });
  await tick();
  assert.equal(h.events('turn-end').length, 1);
  assert.equal(h.session.busy, false);
  assert.deepEqual(h.events('error').map(e => e.message), ['logger bug']);
});

test('exit: stdout that arrives after exit (before close) is still read; the turn ends once', async () => {
  const h = harness({ autoClose: false });
  await h.ready();
  const uuid = h.session.send('hola');
  h.sysInit();
  h.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
  await tick();
  h.child().emit('exit', 0, null);
  h.emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'ok' });
  await tick();
  h.child().emit('close', 0, null);
  assert.deepEqual(h.events('turn-end').map(e => e.terminalReason), ['completed']);
  assert.equal(h.events('exit').length, 1);
});

test('exit in the middle of a turn ends the turn (aborted) before exit', async () => {
  const h = harness();
  await h.ready();
  h.session.send('trabaja');
  h.sysInit();
  await tick();
  h.child().emit('exit', null, 'SIGKILL');
  assert.deepEqual(h.out.filter(o => o.ev === 'turn-end' || o.ev === 'exit').map(o => (o.ev === 'exit' ? 'exit' : `turn-end:${o.terminalReason}:${o.aborted}`)),
    ['turn-end:exit:true', 'exit']);
  assert.equal(h.session.busy, false);
});

test('exit: open prompts are cancelled, and a throwing listener does not stop the exit event', async () => {
  const h = harness();
  await h.ready();
  h.session.send('crea el archivo');
  h.sysInit();
  h.emit({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } });
  await tick();
  h.session.once('turn-end', () => { throw new Error('consumer bug'); });
  h.child().emit('exit', 1, null);
  assert.deepEqual(h.out.filter(o => ['permission-cancelled', 'turn-end', 'exit', 'error'].includes(o.ev)).map(o => o.ev),
    ['permission-cancelled', 'turn-end', 'error', 'exit']);
  assert.equal(h.session.allow('cli-1'), false);
});

test('start: a spawn that fails (no pid) rejects and leaves the session closed', async () => {
  const failing = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const h = harness({ spawn: failing });
  await assert.rejects(h.session.start(), /ENOENT/);
  assert.throws(() => h.session.send('hola'), /closed/);
  assert.equal((await h.session.close()).killed, false);
});

test('permission: answering a cancelled or already answered request writes nothing', async () => {
  const h = harness();
  await h.ready();
  h.emit({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  h.emit({ type: 'control_request', request_id: 'cli-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } } });
  h.emit({ type: 'control_cancel_request', request_id: 'cli-1' });
  await tick();
  assert.equal(h.session.allow('cli-1'), false);
  assert.equal(h.session.deny('cli-2', 'no'), true);
  assert.equal(h.session.allow('cli-2'), false);
  assert.deepEqual(h.writes().filter(w => w.type === 'control_response').map(w => w.response.request_id), ['cli-2']);
});

// ── Closing ──────────────────────────────────────────────────────────────

test('close: idle → stdin ends, the process exits, no kill; idempotent', async () => {
  const h = harness();
  await h.ready();
  const closing = h.session.close();
  assert.equal(h.session.close(), closing);
  await tick();
  assert.equal(h.child().stdinEnded, true);
  h.child().emit('exit', 0, null);
  assert.deepEqual(await closing, { code: 0, signal: null, killed: false, leftovers: [], checked: true });
  assert.deepEqual(h.events('exit').map(e => e.code), [0]);
  assert.equal(h.kills.length, 0);
  assert.throws(() => h.session.send('hola'), /closed/);
});

test('close: busy → interrupt first; a turn that does not stop is killed at once after stdin; leftovers reported', async () => {
  const found = [];
  const h = harness({ findLeftovers: async (id) => { found.push(id); return [{ pid: 777, name: 'claude.exe' }]; } });
  await h.ready();
  h.session.send('trabaja');
  h.sysInit();
  await tick();
  const closing = h.session.close();
  await tick();
  const [stop] = h.writes().filter(w => w.type === 'control_request' && w.request.subtype === 'interrupt');
  assert.deepEqual(stop.request, { subtype: 'interrupt', cancel_queued: true }, 'the turn and any queued message are stopped first');
  assert.equal(h.child().stdinEnded, false, 'stdin stays open until the turn is over');
  h.advance(3000); // the turn never reports its end
  await tick();
  assert.equal(h.child().stdinEnded, true);
  await tick();
  assert.deepEqual(h.kills, [4321], 'no 3 s more of an unattended turn');
  h.child().emit('exit', 1, null);
  const result = await closing;
  assert.equal(result.killed, true);
  assert.deepEqual(result.leftovers, [{ pid: 777, name: 'claude.exe' }]);
  assert.deepEqual(found, [h.session.sessionId]);
  assert.match(h.events('error').at(-1).message, /777/);
});

test('close: a turn that ends after the interrupt closes cleanly without a kill', async () => {
  const h = harness();
  await h.ready();
  const uuid = h.session.send('trabaja');
  h.sysInit();
  h.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
  await tick();
  const closing = h.session.close();
  await tick();
  h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '' });
  await tick();
  await tick();
  assert.equal(h.child().stdinEnded, true);
  h.child().emit('exit', 0, null);
  assert.equal((await closing).killed, false);
  assert.equal(h.kills.length, 0);
});

test('close: without cancel_queued, a queued turn that starts after the interrupt is interrupted too', async () => {
  const h = harness();
  await h.ready();
  const caps = { capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'] };
  const first = h.session.send('trabaja');
  h.sysInit(caps);
  h.emit({ type: 'command_lifecycle', command_uuid: first, state: 'started' });
  const queued = h.session.send('y luego esto');
  await tick();
  const closing = h.session.close();
  await tick();
  const interrupts = () => h.writes().filter(w => w.type === 'control_request' && w.request.subtype === 'interrupt');
  assert.deepEqual(interrupts()[0].request, { subtype: 'interrupt' });
  h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '' });
  h.sysInit(caps); // the queued message starts at once
  h.emit({ type: 'command_lifecycle', command_uuid: queued, state: 'started' });
  await tick();
  await tick();
  assert.equal(interrupts().length, 2, 'the queued turn is interrupted as well');
  assert.equal(h.child().stdinEnded, false);
  h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '' });
  await tick();
  await tick();
  assert.equal(h.child().stdinEnded, true);
  h.child().emit('exit', 1, null);
  assert.equal((await closing).killed, false);
});

// A running Bash tool in a Windows tree: claude.exe → bash.exe; sleep.exe hangs off a dead forked bash (MSYS).
const TREE = [{ pid: 4321, name: 'claude.exe' }, { pid: 600, name: 'node.exe' }, { pid: 500, name: 'bash.exe' }, { pid: 501, name: 'sleep.exe' }];
function busyWithBash(h) {
  const uuid = h.session.send('ejecuta sleep 20');
  h.sysInit();
  h.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
  h.se({ type: 'message_start', message: { id: 'm1' } });
  h.se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash' } });
}
const interrupts = h => h.writes().filter(w => w.type === 'control_request' && w.request.subtype === 'interrupt');

test('close: the tree is captured before stopping the turn; what outlives the session is killed and reported', async () => {
  let release;
  const listed = [];
  const h = harness({
    listTree: (pid) => { listed.push(pid); return new Promise(r => { release = () => r(TREE); }); },
    findLeftovers: async (id, snapshot) => (snapshot === TREE ? [{ pid: 501, name: 'sleep.exe' }, { pid: 900, name: 'claude.exe' }] : []),
  });
  await h.ready();
  busyWithBash(h);
  await tick();
  const closing = h.session.close();
  await tick();
  assert.deepEqual(listed, [4321]);
  assert.equal(interrupts(h).length, 0, 'not stopped before the snapshot (the parent links die with the tool)');
  release();
  await tick();
  assert.equal(interrupts(h).length, 1);
  h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: '' });
  await tick();
  await tick();
  h.child().emit('exit', 1, null);
  const result = await closing;
  assert.equal(result.killed, false, 'the session itself exited on its own');
  assert.deepEqual(result.leftovers, [{ pid: 501, name: 'sleep.exe' }, { pid: 900, name: 'claude.exe' }]);
  assert.deepEqual(h.kills, [501], 'only ours is killed; another process naming the session (a terminal?) is only reported');
  assert.match(h.events('error').at(-1).message, /sleep\.exe 501.*claude\.exe 900/);
});

test('close: a snapshot that hangs does not hold the hang-up more than 2 s', async () => {
  const h = harness({ listTree: () => new Promise(() => {}) });
  await h.ready();
  busyWithBash(h);
  await tick();
  h.session.close();
  await tick();
  h.advance(1999);
  await tick();
  assert.equal(interrupts(h).length, 0);
  h.advance(1);
  await tick();
  assert.equal(interrupts(h).length, 1);
});

test('interrupt during a tool: processes the interrupt orphaned are killed after the turn ends, nothing else', async () => {
  const lists = [TREE, [{ pid: 4321, name: 'claude.exe' }, { pid: 600, name: 'node.exe' }]]; // after: bash gone, sleep unlinked
  const h = harness({
    listTree: async () => lists.shift() || [],
    findLeftovers: async (id, snapshot) => snapshot.filter(p => [4321, 600, 501].includes(p.pid)), // still alive
  });
  await h.ready();
  busyWithBash(h);
  await tick();
  const receipt = h.session.interrupt();
  await tick();
  const [req] = interrupts(h);
  h.emit({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { still_queued: [] } } });
  assert.deepEqual(await receipt, { still_queued: [] });
  for (let i = 0; i < 4; i += 1) await tick();
  assert.deepEqual(h.kills, [], 'nothing before the turn is over');
  h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: '' });
  for (let i = 0; i < 4; i += 1) await tick();
  assert.deepEqual(h.kills, [], 'the CLI gets 500 ms to finish killing its shell');
  h.advance(500);
  for (let i = 0; i < 4; i += 1) await tick();
  assert.deepEqual(h.kills, [501], 'not claude.exe, not the MCP server: both still linked');
  assert.match(h.events('debug').at(-1).message, /sleep\.exe 501/);

  const text = harness({ listTree: () => new Promise(() => {}) });
  await text.ready();
  text.session.send('cuenta');
  text.sysInit();
  text.session.interrupt();
  assert.equal(interrupts(text).length, 1, 'written at once: no snapshot while Claude only writes');
});

test('interrupt during a tool: no reaping when the second snapshot fails, and claude.exe is never killed', async () => {
  for (const after of [[], [{ pid: 600, name: 'node.exe' }], null]) { // empty, without claude.exe, failed
    const lists = [TREE, after];
    const h = harness({
      listTree: async () => lists.shift(),
      findLeftovers: async (id, snapshot) => snapshot.filter(p => [4321, 600, 501].includes(p.pid)),
    });
    await h.ready();
    busyWithBash(h);
    await tick();
    h.session.interrupt();
    await tick();
    h.emit({ type: 'control_response', response: { subtype: 'success', request_id: interrupts(h)[0].request_id, response: {} } });
    h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: '' });
    for (let i = 0; i < 3; i += 1) await tick();
    h.advance(500);
    for (let i = 0; i < 6; i += 1) await tick();
    assert.deepEqual(h.kills, [], JSON.stringify(after));
  }
});

test('interrupt: a turn that ended during the snapshot is not stopped late (it could be the urgent message)', async () => {
  let release;
  const h = harness({ listTree: () => new Promise(r => { release = () => r(TREE); }) });
  await h.ready();
  busyWithBash(h);
  await tick();
  const sent = h.session.sendUrgent('No, para: haz otra cosa');
  await tick();
  assert.equal(interrupts(h).length, 0, 'waiting for the snapshot');
  h.emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'ya' }); // ended by itself
  await tick();
  release();
  const uuid = await sent;
  for (let i = 0; i < 3; i += 1) await tick();
  assert.equal(interrupts(h).length, 0, 'nothing left to stop');
  assert.equal(h.writes().at(-1).uuid, uuid, 'the urgent message is the last thing written');
});

test('interrupt: a listTree that throws at once is contained', async () => {
  const h = harness({ listTree: () => { throw new Error('boom'); } });
  await h.ready();
  busyWithBash(h);
  await tick();
  const receipt = h.session.interrupt();
  await tick();
  assert.equal(interrupts(h).length, 1, 'stopped anyway, without a snapshot');
  h.emit({ type: 'control_response', response: { subtype: 'success', request_id: interrupts(h)[0].request_id, response: { still_queued: [] } } });
  assert.deepEqual(await receipt, { still_queued: [] });
});

test('interrupt: two interrupts during the same tool share one snapshot and one stop', async () => {
  let lists = 0;
  const h = harness({ listTree: async () => { lists += 1; return TREE; } });
  await h.ready();
  busyWithBash(h);
  await tick();
  const a = h.session.interrupt();
  const b = h.session.interrupt();
  await tick();
  assert.equal(lists, 1);
  assert.equal(interrupts(h).length, 1);
  h.emit({ type: 'control_response', response: { subtype: 'success', request_id: interrupts(h)[0].request_id, response: { still_queued: [] } } });
  assert.deepEqual(await a, await b);
});

test('sendUrgent: if Claude never confirms the stop, the words are still sent (they reach it at the next tool boundary)', async () => {
  const h = harness();
  await h.ready();
  busyWithBash(h);
  await tick();
  const sent = h.session.sendUrgent('No, para');
  for (let i = 0; i < 3; i += 1) await tick();
  assert.equal(h.writes().filter(w => w.type === 'user').length, 1);
  h.advance(5000);
  const uuid = await sent;
  assert.equal(h.writes().at(-1).uuid, uuid, 'never lost, even when the CLI does not answer');
});

test('close without cancel_queued: a long queue is drained turn by turn before stdin ends', async () => {
  const h = harness();
  await h.ready();
  const caps = { capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'] };
  const ids = [h.session.send('uno')];
  h.sysInit(caps);
  h.emit({ type: 'command_lifecycle', command_uuid: ids[0], state: 'started' });
  for (const t of ['dos', 'tres', 'cuatro']) ids.push(h.session.send(t));
  await tick();
  const closing = h.session.close();
  for (let turn = 0; turn < 4; turn += 1) {
    for (let i = 0; i < 3; i += 1) await tick();
    assert.equal(interrupts(h).length, turn + 1, `turn ${turn}`);
    assert.equal(h.child().stdinEnded, false);
    h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '' });
    if (turn < 3) {
      h.sysInit(caps);
      h.emit({ type: 'command_lifecycle', command_uuid: ids[turn + 1], state: 'started' });
    }
  }
  for (let i = 0; i < 3; i += 1) await tick();
  assert.equal(h.child().stdinEnded, true);
  h.child().emit('exit', 1, null);
  assert.equal((await closing).killed, false);
});

test('close: the forced kill is awaited, and a session that survives it is reported, not hidden', async () => {
  let finishKill;
  const h = harness({
    killTree: (pid) => { h.kills.push(pid); return new Promise(r => { finishKill = r; }); },
    findLeftovers: async () => [],
  });
  await h.ready();
  const closing = h.session.close();
  await tick();
  h.advance(3000); // no exit after stdin
  await tick();
  assert.deepEqual(h.kills, [4321]);
  let settled = false;
  closing.then(() => { settled = true; });
  h.advance(3000);
  for (let i = 0; i < 3; i += 1) await tick();
  assert.equal(settled, false, 'close waits for the kill');
  finishKill();
  await tick();
  h.advance(3000); // and it still does not exit
  for (let i = 0; i < 4; i += 1) await tick();
  const result = await closing;
  assert.equal(result.killed, true);
  assert.deepEqual(result.leftovers.map(p => p.pid), [4321], 'claude.exe itself is still running');
});

test('close: a process check that failed is reported as unchecked, never as clean', async () => {
  const h = harness({ findLeftovers: async () => null });
  await h.ready();
  const closing = h.session.close();
  await tick();
  h.child().emit('exit', 0, null);
  const result = await closing;
  assert.equal(result.checked, false);
  assert.match(h.events('error').at(-1).message, /could not check/i);
});

test('sameProcess: same pid and name is not enough, the start time must match too', () => {
  assert.equal(sameProcess({ pid: 501, name: 'sleep.exe', created: 10 }, { pid: 501, name: 'SLEEP.EXE', created: 10 }), true);
  assert.equal(sameProcess({ pid: 501, name: 'sleep.exe', created: 10 }, { pid: 501, name: 'sleep.exe', created: 99 }), false, 'pid reused');
  assert.equal(sameProcess({ pid: 501, name: 'sleep.exe' }, { pid: 501, name: 'sleep.exe', created: 10 }), false, 'no start time: not provable');
  assert.equal(sameProcess({ pid: 501, name: 'sleep.exe', created: 10 }, { pid: 502, name: 'sleep.exe', created: 10 }), false);
});

test('parsePs: Git Bash `ps -e` rows (status column, two-word start time, spaces in the command)', () => {
  const out = [
    '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
    '      621     617     617      36664  ?         197609 18:24:57 /usr/bin/tail',
    'I   13000   12998   12994      69708  pty0      197609   Nov  2 /usr/bin/sleep',
    '    13010   13000   12994      69710  ?         197609 20:31:14 /c/Program Files/nodejs/node',
    '',
  ].join('\n');
  assert.deepEqual(parsePs(out), [
    { pid: 621, ppid: 617, winpid: 36664 },
    { pid: 13000, ppid: 12998, winpid: 69708 },
    { pid: 13010, ppid: 13000, winpid: 69710 },
  ]);
  assert.deepEqual(parsePs(''), []);
});

test('linkTree: Windows parent links plus the MSYS links Git Bash keeps when the Windows parent is gone', () => {
  const all = [
    { pid: 100, ppid: 1, name: 'explorer.exe' },
    { pid: 4321, ppid: 100, name: 'claude.exe' },
    { pid: 600, ppid: 4321, name: 'node.exe' },
    { pid: 500, ppid: 4321, name: 'bash.exe' },
    { pid: 501, ppid: 9999, name: 'sleep.exe' },   // its forked bash already exited
    { pid: 502, ppid: 501, name: 'conhost.exe' },
    { pid: 700, ppid: 100, name: 'sleep.exe' },    // somebody else's
  ];
  const msys = [{ pid: 10, ppid: 1, winpid: 500 }, { pid: 11, ppid: 10, winpid: 501 }, { pid: 20, ppid: 1, winpid: 700 }];
  assert.deepEqual(linkTree(4321, all, msys).map(p => `${p.pid}:${p.name}`).sort(),
    ['4321:claude.exe', '500:bash.exe', '501:sleep.exe', '502:conhost.exe', '600:node.exe']);
  assert.deepEqual(linkTree(4321, all, []).map(p => p.pid).sort(), [4321, 500, 600]);
});

test('linkTree: a parent pid reused by a newer process does not adopt the older one (explorer.exe)', () => {
  const all = [
    { pid: 4321, ppid: 100, name: 'claude.exe', created: 5000 },
    { pid: 500, ppid: 4321, name: 'bash.exe', created: 6000 },         // reuses the pid of explorer's dead parent
    { pid: 900, ppid: 500, name: 'explorer.exe', created: 10 },        // much older than this bash.exe
    { pid: 901, ppid: 900, name: 'Code.exe', created: 20 },
    { pid: 502, ppid: 500, name: 'sleep.exe', created: 7000 },
  ];
  assert.deepEqual(linkTree(4321, all, []).map(p => p.pid).sort(), [4321, 500, 502]);
});

// ── Executable ───────────────────────────────────────────────────────────

test('resolveClaude (Windows): claude.exe on PATH, or the native binary behind the npm claude.cmd shim', () => {
  const files = new Set([
    'C:\\npm\\claude.cmd',
    'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    'C:\\Users\\me\\.local\\bin\\claude.exe',
  ]);
  const exists = p => files.has(p);
  const win = { platform: 'win32', exists };
  assert.equal(resolveClaude('claude', { ...win, env: { PATH: 'C:\\empty;C:\\npm' } }), 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
  assert.equal(resolveClaude('claude', { ...win, env: { Path: 'C:\\Users\\me\\.local\\bin;C:\\npm' } }), 'C:\\Users\\me\\.local\\bin\\claude.exe');
  assert.equal(resolveClaude('C:\\npm\\claude.cmd', { ...win, env: {} }), 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
  assert.equal(resolveClaude('D:\\x\\claude.exe', { ...win, env: {} }), 'D:\\x\\claude.exe');
  assert.equal(resolveClaude('claude', { ...win, env: { PATH: 'C:\\nowhere' } }), 'claude', 'left to spawn, which reports ENOENT');
  assert.equal(resolveClaude('claude', { platform: 'linux', exists, env: {} }), 'claude');
});
