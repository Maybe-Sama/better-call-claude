'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const os = require('node:os');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CallBroker, MIN_RESULT_TURN_MS } = require('./broker');
const { readSessionTitle } = require('./session-title');
const { VoiceConversation, classifyUrgency } = require('./voice/conversation');
const { VoiceMetrics, jsonlSink } = require('./voice/metrics');
const { sttContextFor } = require('./voice/stt-context');

// Optional user settings in %LOCALAPPDATA%AgentCallconfig.json, e.g.
//   {"mic": "IN 1 (BEHRINGER", "voice": "ef_dora", "whisperModel": "small", "vocab": "Eureka, Supabase"}
// Environment variables still win, so a one-off run can override them.
const CONFIG_KEYS = {
  mic: 'AGENTCALL_MIC', voice: 'AGENTCALL_TTS_VOICE', ttsEngine: 'AGENTCALL_TTS_ENGINE', sttEngine: 'AGENTCALL_STT_ENGINE',
  whisperModel: 'AGENTCALL_WHISPER_MODEL', whisperPartialModel: 'AGENTCALL_WHISPER_PARTIAL_MODEL', vocab: 'AGENTCALL_STT_VOCAB',
  minResultSeconds: 'AGENTCALL_MIN_RESULT_SECONDS', port: 'AGENTCALL_PORT',
  defaultMode: 'AGENTCALL_DEFAULT_MODE',
  ttsProvider: 'AGENTCALL_TTS_PROVIDER', edgeVoice: 'AGENTCALL_EDGE_VOICE', edgeRate: 'AGENTCALL_EDGE_RATE',
  micGain: 'AGENTCALL_MIC_GAIN', speechThreshold: 'AGENTCALL_SPEECH_THRESHOLD', whisperBackend: 'AGENTCALL_WHISPER_BACKEND',
  voiceMetrics: 'AGENTCALL_VOICE_METRICS', capture: 'AGENTCALL_CAPTURE', streamModel: 'AGENTCALL_STREAM_MODEL',
};
try {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA || '', 'AgentCall', 'config.json'), 'utf8'));
  for (const [key, env] of Object.entries(CONFIG_KEYS)) {
    if (config[key] != null && process.env[env] == null) process.env[env] = String(config[key]);
  }
} catch { /* no config file: defaults */ }

const HOST = '127.0.0.1';
// Numeric settings come from env/config.json: anything invalid falls back to the default.
function numberSetting(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  console.error(`[AgentCall] Ignoro ${name}=${raw}: debe ser un número entre ${min} y ${max}.`);
  return fallback;
}
const PORT = numberSetting('AGENTCALL_PORT', 32147, 1024, 65535);
const MIN_RESULT_MS = numberSetting('AGENTCALL_MIN_RESULT_SECONDS', MIN_RESULT_TURN_MS / 1000, 0, 3600) * 1000;
const VERSION = require('../package.json').version;

// Sessions call only after "/saul on", unless started by run-claude-with-agentcall.ps1
// (header X-AgentCall-Mode: on) or defaultMode is "on".
const broker = new CallBroker({
  minResultMs: MIN_RESULT_MS,
  readTitle: readSessionTitle,
  defaultMode: process.env.AGENTCALL_DEFAULT_MODE === 'on' ? 'on' : 'off',
});

let mainWindow = null;
let tray = null;
let server = null;
let quitting = false;
let muted = false;
let ttsSpeaking = false;
let stt = null;
let lastPersisted = '';

if (!app.requestSingleInstanceLock()) {
  // Another AgentCall already owns the port and the tray; just bring it forward.
  app.quit();
} else {
  app.on('second-instance', () => showWindow({ focus: true }));
}

function log(...args) {
  console.log(`[AgentCall ${new Date().toLocaleTimeString()}]`, ...args);
}

function stateFile() {
  return path.join(app.getPath('userData'), 'operational-state.json');
}

function persistOperationalState() {
  const data = JSON.stringify(broker.exportPersistentState());
  if (data === lastPersisted) return;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(stateFile(), data, 'utf8');
    lastPersisted = data;
  } catch (err) {
    console.error('[AgentCall] Could not persist state:', err.message);
  }
}

function loadOperationalState() {
  try {
    if (!fs.existsSync(stateFile())) return;
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    broker.importPersistentState(saved);
    lastPersisted = JSON.stringify(broker.exportPersistentState());
  } catch (err) {
    console.error('[AgentCall] Could not restore state:', err.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 470,
    height: 720,
    minWidth: 420,
    minHeight: 620,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0b0d12',
    title: 'AgentCall',
    icon: path.join(__dirname, '..', 'assets', 'agentcall.png'),
    alwaysOnTop: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => showWindow({ focus: false }));
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir AgentCall', click: () => showWindow({ focus: true }) },
    { type: 'separator' },
    { label: 'No molestar', type: 'checkbox', checked: broker.dnd, click: (item) => broker.setDnd(item.checked) },
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.setToolTip(broker.dnd ? 'AgentCall · No molestar' : 'AgentCall');
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'agentcall.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 20, height: 20 }));
  buildTrayMenu();
  tray.on('click', () => showWindow({ focus: true }));
  tray.on('double-click', () => showWindow({ focus: true }));
}

// Ringing must be visible over other windows without stealing the keyboard from the terminal.
function showWindow({ focus = false, onTop = false } = {}) {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.setAlwaysOnTop(onTop, 'floating');
  if (focus) {
    mainWindow.show();
    mainWindow.focus();
  } else if (!mainWindow.isVisible() || onTop) {
    mainWindow.showInactive();
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function activeCall(snapshot = broker.getSnapshot()) {
  return snapshot.calls.find(c => c.id === snapshot.activeId) || null;
}

let lastDnd = broker.dnd;
broker.on('change', (snapshot, detail) => {
  persistOperationalState();
  if (lastDnd !== broker.dnd) { lastDnd = broker.dnd; buildTrayMenu(); }
  sendToRenderer('agentcall:state', snapshot);

  const active = activeCall(snapshot);
  voice.setCall(active);
  const ringing = snapshot.calls.some(c => c.status === 'ringing');
  if (detail.event === 'ringing') { showWindow({ onTop: true }); prepareSpeech(snapshot.calls.find(c => c.id === detail.id)); }
  else if (detail.event === 'active') showWindow({ focus: true, onTop: true });
  else if (!active && !ringing && mainWindow?.isAlwaysOnTop()) mainWindow.setAlwaysOnTop(false);

  reconcileStt(active);
});

// While the phone rings, Claude's first words are synthesised, so they play the moment the user answers.
function prepareSpeech(call) {
  const latest = [...(call?.messages || [])].reverse().find(m => m.role === 'assistant');
  const text = String(latest?.speech || latest?.text || '').replace(/\s+/g, ' ').trim();
  if (text) tts.send({ cmd: 'prepare', text });
}

// ── Hook server ──────────────────────────────────────────────────────────────

function jsonResponse(res, status, body) {
  if (res.writableEnded || res.destroyed) return false;
  const payload = body == null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// A held hook keeps the HTTP request open until the user answers. If Claude Code drops the request
// (hook timeout, Claude exits), the call is cancelled so AgentCall never shows a ghost call.
function holdHook(res, label) {
  let done = false;
  let callId = null;
  res.on('close', () => {
    if (!done && callId) {
      log(`${label}: Claude cerró la petición antes de responder`);
      broker.cancel(callId);
    }
  });
  return {
    // Returns whether the response could be written (false: Claude already closed the request).
    respond(body) {
      if (done) return false;
      done = true;
      log(`${label} → ${JSON.stringify(body || {}).slice(0, 160)}`);
      return jsonResponse(res, 200, body || {});
    },
    bind(call) {
      if (call) callId = call.id;
      if (res.destroyed && !done && callId) broker.cancel(callId);
    },
  };
}

async function routeHook(req, res) {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && url === '/health') {
    const snap = broker.getSnapshot();
    return jsonResponse(res, 200, {
      ok: true, service: 'AgentCall', version: VERSION, port: PORT, dnd: broker.dnd,
      activeCall: Boolean(snap.activeId), calls: snap.calls.length, counts: snap.counts,
    });
  }
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method_not_allowed' });

  let body;
  try { body = await readJson(req); }
  catch (err) { return jsonResponse(res, 400, { error: err.message }); }
  const session = String(body.session_id || '').slice(0, 8);
  const hint = String(req.headers['x-agentcall-mode'] || '').trim().toLowerCase();

  switch (url) {
    case '/hooks/session-start': {
      const context = broker.sessionStartContext(body, hint);
      log(`SessionStart [${session}] llamadas ${broker.sessionMode(body.session_id, hint).toUpperCase()}`);
      return jsonResponse(res, 200, context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : {});
    }

    case '/hooks/user-prompt-submit': {
      const context = broker.notePrompt(body, hint);
      if (!context) return jsonResponse(res, 200, {});
      log(`UserPromptSubmit [${session}] → contexto (${broker.sessionMode(body.session_id, hint)})`);
      if (!jsonResponse(res, 200, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })) broker.restorePendingSpeech(body.session_id);
      return;
    }

    case '/hooks/post-tool-use': {
      const output = broker.noteToolDone(body);
      if (output) log(`PostToolUse [${session}] → entrego lo dicho en la llamada`);
      if (!jsonResponse(res, 200, output || {}) && output) broker.restorePendingSpeech(body.session_id);
      return;
    }

    case '/hooks/ask-user': {
      log(`AskUserQuestion [${session}]`);
      const hook = holdHook(res, `AskUserQuestion [${session}]`);
      hook.bind(broker.receiveAskUser(body, hook.respond, hint));
      return;
    }

    case '/hooks/permission': {
      log(`PermissionRequest ${body.tool_name} [${session}]`);
      const hook = holdHook(res, `PermissionRequest [${session}]`);
      hook.bind(broker.receivePermission(body, hook.respond, hint));
      return;
    }

    case '/hooks/stop': {
      log(`Stop [${session}] stop_hook_active=${Boolean(body.stop_hook_active)}`);
      const hook = holdHook(res, `Stop [${session}]`);
      hook.bind(broker.receiveCompletion(body, { responder: hook.respond, hint }));
      return;
    }

    case '/hooks/stop-failure':
      log(`StopFailure [${session}] ${body.error || ''}`);
      broker.receiveCompletion(body, { failure: true, hint });
      return jsonResponse(res, 200, {});

    default:
      return jsonResponse(res, 404, { error: 'not_found' });
  }
}

function startHookServer() {
  server = http.createServer((req, res) => {
    routeHook(req, res).catch((err) => {
      console.error('[AgentCall] Hook error:', err);
      jsonResponse(res, 500, { error: 'internal_error' });
    });
  });
  // Held requests may legitimately stay open for hours.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.on('error', (err) => {
    console.error('[AgentCall] HTTP server failed:', err.message);
    const message = err.code === 'EADDRINUSE'
      ? `El puerto ${PORT} ya está en uso: ¿hay otro AgentCall abierto? Claude no podrá llamarte desde esta ventana.`
      : `No se pudo abrir el puerto ${PORT}: ${err.message}`;
    sendToRenderer('agentcall:service-error', message);
  });
  server.listen(PORT, HOST, () => {
    log(`Escuchando en http://${HOST}:${PORT}`);
    rememberLaunchCommand();
  });
}

// "/saul on" opens AgentCall when it is closed (claude-plugin/hooks/ensure-running.js); it starts the
// copy that ran last, wherever it is installed.
function rememberLaunchCommand() {
  try {
    fs.mkdirSync(AGENTCALL_DATA, { recursive: true });
    fs.writeFileSync(path.join(AGENTCALL_DATA, 'launch.json'),
      JSON.stringify({ electron: process.execPath, appDir: app.getAppPath() }, null, 2));
  } catch (err) { log(`launch.json: ${err.message}`); }
}

// ── Speech recognition ───────────────────────────────────────────────────────
// Free engines, same line protocol (see src/speech):
//   whisper – faster-whisper on CPU, fully local (installed by scripts/setup-whisper.ps1). Preferred.
//   winrt   – modern Windows dictation. Good Spanish, but needs "Reconocimiento de voz en línea" (cloud).
//   classic – System.Speech (offline, ships with Windows). Last resort; weak with free dictation.
// AGENTCALL_STT_ENGINE=auto (default) tries them in that order; whisper|winrt|classic forces one.

const STT_CULTURE = process.env.AGENTCALL_STT_CULTURE || 'es-ES';
const STT_ENGINE = (process.env.AGENTCALL_STT_ENGINE || 'auto').toLowerCase();
const AGENTCALL_DATA = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'AgentCall');
const WHISPER_PYTHON = path.join(AGENTCALL_DATA, 'whisper-venv', 'Scripts', 'python.exe');
// Optional GPU backend (scripts/setup-whisper-gpu.ps1): large-v3-turbo through DirectML in its own venv.
const GPU_PYTHON = path.join(AGENTCALL_DATA, 'gpu-venv', 'Scripts', 'python.exe');
const GPU_MODEL = path.join(AGENTCALL_DATA, 'models', 'whisper-turbo-onnx', 'onnx', 'encoder_model_fp16.onnx');
let whisperGpu = (process.env.AGENTCALL_WHISPER_BACKEND || 'cpu') === 'dml' && fs.existsSync(GPU_PYTHON) && fs.existsSync(GPU_MODEL);
let whisperUnavailable = !['auto', 'whisper'].includes(STT_ENGINE) || !(fs.existsSync(WHISPER_PYTHON) || whisperGpu);
let winrtExe = null;
// "aec": the window captures the microphone with Chromium echo cancellation and streams it to Whisper
// (--source stdin); "device" (default): Whisper opens the microphone itself. aec falls back to device.
// Echo-cancelled capture by default: measured 2026-11-02, Claude's voice at full volume next to the mic
// drops ~43 dB (below the room's silence) and a 45 s answer never cut itself. 'device' (Whisper opens the
// mic itself, no echo cancellation) remains as the fallback when the window cannot capture.
let captureMode = (process.env.AGENTCALL_CAPTURE || 'aec').toLowerCase() === 'device' ? 'device' : 'aec';
let captureOn = false;
let winrtUnavailable = !['auto', 'winrt'].includes(STT_ENGINE);

function prepareWinRtEngine() {
  if (process.platform !== 'win32' || winrtUnavailable) return;
  const script = path.join(__dirname, 'speech', 'build-winrt-stt.ps1');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('exit', (code) => {
    const exe = out.trim().split(/\r?\n/).pop();
    if (code === 0 && exe && fs.existsSync(exe)) {
      winrtExe = exe;
      log(`STT: motor de dictado moderno de Windows listo (${exe})`);
    } else {
      winrtUnavailable = true;
      log(`STT: no se pudo compilar el motor moderno, uso System.Speech. ${err.trim().slice(0, 300)}`);
    }
  });
}

class SttManager {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.listening = false;
    this.engine = null;
  }

  ensure() {
    if (process.platform !== 'win32' || this.child) return;
    const useWhisper = !whisperUnavailable;
    const useWinRt = !useWhisper && !winrtUnavailable && winrtExe;
    let child;
    if (useWhisper) {
      child = spawn(whisperGpu ? GPU_PYTHON : WHISPER_PYTHON, ['-u', path.join(__dirname, 'speech', 'whisper_worker.py'),
        '--language', STT_CULTURE.split('-')[0], '--models-dir', path.join(AGENTCALL_DATA, 'models'),
        '--backend', whisperGpu ? 'dml' : 'cpu', '--source', captureMode === 'aec' ? 'stdin' : 'device'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } else if (useWinRt) {
      child = spawn(winrtExe, [STT_CULTURE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      const script = path.join(__dirname, 'speech', 'stt-worker.ps1');
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Culture', STT_CULTURE],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    this.child = child;
    this.ready = false;
    this.engine = useWhisper ? 'whisper' : useWinRt ? 'winrt' : 'classic';
    this.source = useWhisper && captureMode === 'aec' ? 'stdin' : 'device';
    this.droppedPcm = 0;
    this.listening = false;
    this.buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); }
        catch { console.error('[AgentCall STT] unparsable line:', line.slice(0, 200)); continue; }
        this.onEvent(child, event);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => console.error('[AgentCall STT]', text.trim()));
    child.stdin.on('error', () => {});
    // The executable could not be launched at all: treat it like a fatal start-up error.
    child.on('error', (err) => this.onEvent(child, { type: 'error', engine: this.engine, fatal: this.engine !== 'classic', message: err.message }));
    child.on('exit', (code) => {
      const expected = child.agentcallStopping;
      if (this.child === child) this.child = null;
      if (!expected && code && !child.agentcallReplaced) {
        sendToRenderer('agentcall:stt', { type: 'error', message: 'El reconocimiento de voz de Windows se ha detenido.', hint: 'Puedes seguir escribiendo en el campo de texto.' });
      }
    });
  }

  onEvent(child, event) {
    if (event.type === 'mic') log(`STT: micrófono ${event.name}`);
    if (event.type === 'speech' && event.state === 'end' && event.rms != null) log(`STT voz: pico ${event.peak} · media ${event.rms} · umbral ${event.threshold}`);
    if (event.type === 'final' || event.type === 'ready' || event.type === 'error') {
      log(`STT[${this.engine}] ${event.type}: ${event.text || event.message || event.recognizer || ''}${event.confidence != null ? ` (confianza ${event.confidence}${event.peak != null ? `, pico ${event.peak}` : ''})` : ''}`);
    }
    // An engine that cannot start (Whisper not loadable, Windows dictation not allowed) hands over to the next.
    // (Windows dictation reports its privacy refusal right after 'ready'; Whisper reports microphone
    // failures after loading.) Workers flag those errors as fatal.
    const fatal = event.type === 'error' && this.child === child && event.fatal &&
      ['whisper', 'winrt'].includes(event.engine) && STT_ENGINE !== event.engine;
    if (event.type === 'ready' && this.child === child) this.ready = true;
    // The GPU backend failing first falls back to Whisper on the CPU before trying other engines.
    if (event.type === 'error' && event.fatal && event.engine === 'whisper' && whisperGpu && this.child === child && !this.ready) {
      log(`STT: Whisper en GPU no ha arrancado (${event.message}); uso la CPU.`);
      whisperGpu = false;
      const wasListening = this.listening;
      child.agentcallReplaced = true;
      child.agentcallStopping = true;
      this.child = null;
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      if (!fs.existsSync(WHISPER_PYTHON)) whisperUnavailable = true;
      this.ensure();
      if (wasListening) this.setListening(true);
      return;
    }
    if (fatal) {
      if (event.engine === 'whisper') whisperUnavailable = true;
      if (event.engine === 'winrt') winrtUnavailable = true;
      {
        log(`STT: el motor ${event.engine} no ha podido arrancar; paso al siguiente.`);
        if (whisperUnavailable && (winrtUnavailable || !winrtExe)) {
          sendToRenderer('agentcall:stt', { type: 'engine', engine: 'classic', note: 'Reconocimiento básico de Windows (entiende mal). Instala Whisper local con scripts\\setup-whisper.ps1 para entenderte bien.' });
        }
        const wasListening = this.listening;
        child.agentcallReplaced = true;
        child.agentcallStopping = true;
        this.child = null;
        try { child.stdin.end(); } catch {}
        try { child.kill(); } catch {}
        this.ensure();
        if (wasListening) this.setListening(true);
        return;
      }
    }
    if (event.type === 'ready') event.engine = this.engine;
    if (this.child === child) voice.stt(event);
    sendToRenderer('agentcall:stt', event);
  }

  // Tell the recognizer what Claude just said or asked, so option names and project terms are expected.
  setContext(context) {
    if (!this.child || !context) return;
    const key = JSON.stringify(context);
    if (this.contextKey === key && this.contextChild === this.child) return;
    this.contextKey = key;
    this.contextChild = this.child;
    const json = JSON.stringify({ cmd: 'context', ...context }).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    try { this.child.stdin.write(`${json}\n`); } catch {}
  }

  // Audio from the window (echo-cancelled capture), 16 kHz int16 frames.
  writePcm(data) {
    const child = this.child;
    if (!child || !this.listening || this.source !== 'stdin' || !data) return;
    if (child.stdin.writableLength > 2_000_000) { this.droppedPcm += 1; return; } // worker stuck: never grow without bound
    try { child.stdin.write(`{"pcm":"${Buffer.from(data).toString('base64')}"}\n`); } catch {}
  }

  setListening(value) {
    if (!this.child) return;
    if (this.listening === value) return;
    this.listening = value;
    try { this.child.stdin.write(value ? 'listen\n' : 'pause\n'); } catch {}
  }

  // End of a call. Whisper stays loaded (paused) so the next call does not wait for the model.
  idle() {
    if (this.engine === 'whisper' && this.child) return this.setListening(false);
    this.stop();
  }

  stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.listening = false;
    child.agentcallStopping = true;
    try { child.stdin.end(); } catch {}
    setTimeout(() => { try { if (child.exitCode == null) child.kill(); } catch {} }, 2500).unref?.();
  }
}

// ── Voice (Kokoro, local neural TTS) ─────────────────────────────────────────
// Persistent worker with the model loaded; it streams PCM per sentence and the renderer plays it.
// Missing model or worker failure → the renderer falls back to Chromium/Windows voices.
const KOKORO_DIR = path.join(AGENTCALL_DATA, 'models', 'kokoro');

class TtsManager {
  constructor() {
    this.child = null;
    this.ready = false;
    this.buffer = '';
    this.failures = 0;
  }

  available() {
    return process.platform === 'win32' && (process.env.AGENTCALL_TTS_ENGINE || 'kokoro') === 'kokoro' &&
      fs.existsSync(WHISPER_PYTHON) && fs.existsSync(path.join(KOKORO_DIR, 'kokoro-v1.0.onnx'));
  }

  start() {
    if (this.child || !this.available() || this.failures >= 3) return;
    const child = spawn(WHISPER_PYTHON, ['-u', path.join(__dirname, 'speech', 'tts_worker.py'), '--models-dir', KOKORO_DIR],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'ready') { this.ready = true; log(`TTS: ${event.engine} listo (voz ${event.voice})`); syncEchoMode(); }
        if (event.type === 'warning') log(`TTS aviso: ${event.message}`);
        if (event.type === 'error') log(`TTS error: ${event.message}`);
        sendToRenderer('agentcall:tts', event);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { if (!/warn/i.test(text)) console.error('[AgentCall TTS]', text.trim()); });
    child.stdin.on('error', () => {});
    child.on('error', (err) => log(`TTS: no se pudo arrancar Kokoro: ${err.message}`));
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      syncEchoMode();
      this.failures += 1;
      sendToRenderer('agentcall:tts', { type: 'unavailable' });
      if (!quitting) setTimeout(() => this.start(), 2000).unref?.();
    });
  }

  send(message) {
    if (!this.child || !this.ready) return false;
    const json = JSON.stringify(message).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    try { this.child.stdin.write(`${json}\n`); return true; } catch { return false; }
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) { try { child.stdin.end(); } catch {} setTimeout(() => { try { child.kill(); } catch {} }, 1500).unref?.(); }
  }
}
const tts = new TtsManager();

// ── Voice conversation ───────────────────────────────────────────────────────
// VoiceConversation (src/voice/conversation.js) owns turn-taking; the renderer only shows and plays.
// What the user says goes to the held hook when Claude is waiting for it, otherwise to the session's
// queue, which hooks deliver at the next safe point (broker.queueUserSpeech).
const metrics = new VoiceMetrics({
  sink: /^(1|true)$/i.test(process.env.AGENTCALL_VOICE_METRICS || '') ? jsonlSink(path.join(AGENTCALL_DATA, 'voice-metrics.jsonl')) : null,
});

function routeUserText({ callId, sessionId, text, urgency, source }) {
  const call = broker.calls.get(callId);
  // Controlled call with nothing held: straight to that Claude session (new turn, addition or correction).
  if (call?.stream && !(call.responder && !call.resolved) && streamCalls?.owns(callId)) {
    const result = streamCalls.say(callId, text, urgency || classifyUrgency(text));
    log(`Voz → sesión controlada ${result.route}${urgency === 'interrupt' ? ' (interrumpe)' : ''} (${String(text).length} caracteres, ${source})`);
    return result;
  }
  if (!call) {
    // The call ended mid-sentence (hung up, replaced): the words still go to that session.
    if (!sessionId) return { ok: false, error: 'Esta llamada ya no existe.' };
    log(`Voz → cola de la sesión (${String(text).length} caracteres, ${source})`);
    return { ...broker.queueSessionSpeech(sessionId, text, urgency || classifyUrgency(text)), route: 'steer' };
  }
  const answering = Boolean(call.responder && !call.resolved);
  const result = answering ? broker.submitUserText(callId, text) : broker.queueUserSpeech(callId, text, urgency || classifyUrgency(text));
  log(`Voz → ${answering ? 'respuesta' : `cola ${result.urgency || ''}`} (${String(text).length} caracteres, ${source})`);
  return { ...result, route: answering ? 'answer' : 'steer' };
}

const voice = new VoiceConversation({ deliver: routeUserText });
voice.on('speak', ({ id, text }) => sendToRenderer('agentcall:voice', { cmd: 'speak', id, text }));
voice.on('tts', ({ action, id }) => {
  if (action === 'stop') tts.send({ cmd: 'stop', id });
  sendToRenderer('agentcall:voice', { cmd: action });
});
voice.on('ack', ({ id, phrase }) => {
  if (!tts.ready) { voice.tts({ type: 'end', id }); return; } // no neural voice: no acknowledgement
  // The window learns the id first: the pre-rendered audio may come back from the worker at once.
  sendToRenderer('agentcall:voice', { cmd: 'ack', id });
  if (!tts.send({ cmd: 'ack', id, phrase })) { sendToRenderer('agentcall:voice', { cmd: 'stop' }); voice.tts({ type: 'end', id }); }
});
// Streamed answer: the window learns the id first, then the worker renders each sentence as it arrives.
voice.on('speak-stream', ({ id, action, text }) => {
  sendToRenderer('agentcall:voice', { cmd: `stream-${action}`, id, text });
  tts.send({ cmd: `stream-${action}`, id, text });
});
voice.on('append', ({ text }) => sendToRenderer('agentcall:voice', { cmd: 'append', text }));
voice.on('unheard', ({ callId, text }) => streamCalls?.unheard(callId, text));
voice.on('error', ({ message }) => sendToRenderer('agentcall:voice', { cmd: 'error', message }));
voice.on('ui', snapshot => sendToRenderer('agentcall:voice-ui', snapshot));
voice.on('local', ({ intent }) => log(`Voz: ${intent === 'resume' ? 'sigue donde lo dejó' : 'repite lo último'}`));
voice.on('metric', ({ name, ms }) => metrics.record(name, ms));
voice.on('debug', message => log(`Voz: ${message}`));
voice.on('failure', category => { try { metrics.fail(category); } catch {} });

// ── Controlled calls: "Llamar a Claude" (src/voice/stream-call.js) ──────────
// AgentCall starts and drives a Claude Code session itself (stream-json), so Claude talks while it
// writes and can really be interrupted. Loaded lazily: hook mode keeps working without these modules.
let streamCalls = null;
function streamController() {
  if (streamCalls) return streamCalls;
  const { StreamCallController } = require('./voice/stream-call');
  const { StreamSession } = require('./voice/stream-session');
  const { SpeechChunker } = require('./voice/speech-chunker');
  streamCalls = new StreamCallController({
    broker,
    voice,
    createSession: ({ cwd, resume, appendSystemPrompt }) => new StreamSession({ cwd, resume, appendSystemPrompt, model: process.env.AGENTCALL_STREAM_MODEL || null }),
    createChunker: () => new SpeechChunker(),
    log,
  });
  return streamCalls;
}

// The newest Claude Code conversation recorded for a folder (~/.claude/projects/<folder as dashes>).
function latestSessionFor(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ id: f.slice(0, -6), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0] || null;
  } catch { return null; }
}

function lastKnownCwd() {
  let best = null;
  for (const s of broker.sessions.values()) if (s.cwd && (!best || (s.lastPromptAt || 0) > (best.lastPromptAt || 0))) best = s;
  return best?.cwd || os.homedir();
}

// options.cwd / options.fresh skip the dialogs (tests and automation); the button always asks.
async function startStreamCall(options = {}) {
  if (broker.activeId) return { ok: false, error: 'Ya estás en una llamada.' };
  let cwd = typeof options.cwd === 'string' && fs.existsSync(options.cwd) ? options.cwd : null;
  if (!cwd) {
    const pick = await dialog.showOpenDialog(mainWindow, { title: 'Llamar a Claude: ¿en qué proyecto?', defaultPath: lastKnownCwd(), properties: ['openDirectory'] });
    if (pick.canceled || !pick.filePaths?.[0]) return { ok: false, cancelled: true };
    cwd = pick.filePaths[0];
  }
  let resume = null;
  const last = options.fresh ? null : latestSessionFor(cwd);
  if (last) {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Continuar la última conversación', 'Conversación nueva', 'Cancelar'],
      defaultId: 0,
      cancelId: 2,
      message: '¿Sigues donde lo dejaste?',
      detail: `Última conversación en esta carpeta: ${new Date(last.mtime).toLocaleString()}.\nSi sigue abierta en una terminal, ciérrala antes: dos procesos en la misma conversación la parten en dos.`,
    });
    if (answer.response === 2) return { ok: false, cancelled: true };
    if (answer.response === 0) resume = last.id;
  }
  try {
    const call = await streamController().start({ cwd, resume });
    return { ok: true, id: call.id };
  } catch (err) {
    log(`Llamada controlada: ${err.message}`);
    return { ok: false, error: `No se pudo abrir la sesión de Claude: ${err.message}` };
  }
}

// The microphone opens as soon as the call is answered and stays open while Claude speaks and works.
// Recognition context for the active call: vocabulary only (src/voice/stt-context.js).
function reconcileStt(active = activeCall()) {
  if (!stt) return;
  if (!active) { syncCapture(false); return stt.idle(); }
  stt.ensure();
  stt.setContext(sttContextFor(active));
  // The microphone stays open for the whole call: what is said while Claude works is queued for it.
  stt.setListening(!muted);
  syncCapture(!muted);
}

// The voice detector may cut Claude only when the microphone cannot hear it: echo-cancelled capture AND
// Claude speaking through the neural voice (the Windows fallback voice is not in the canceller's reference).
let captureEchoCancelled = false;
function syncEchoMode() { voice.setEchoCancelled(captureEchoCancelled && tts.ready); }

// Echo-cancelled capture runs only during a call (the Windows microphone indicator stays off otherwise).
function syncCapture(wanted) {
  const on = Boolean(wanted && captureMode === 'aec' && stt?.source === 'stdin');
  if (on === captureOn) return;
  captureOn = on;
  // AGENTCALL_CAPTURE_AEC=0: same path without echo cancellation (voice lab A/B).
  sendToRenderer('agentcall:capture', { on, mic: process.env.AGENTCALL_MIC || '', aec: process.env.AGENTCALL_CAPTURE_AEC !== '0' });
}

function onCaptureStatus(status = {}) {
  // Echo cancellation was requested but the system did not grant it: without it, trusting the voice
  // detector would let Claude's own voice cut Claude. Use the direct microphone instead.
  if (status.ok && !status.echoCancellation && process.env.AGENTCALL_CAPTURE_AEC !== '0') {
    status = { ok: false, error: 'el sistema no ofrece cancelación de eco para este micrófono' };
    sendToRenderer('agentcall:capture', { on: false });
  }
  if (status.ok) {
    log(`Micro: ${status.label || 'predeterminado'} · cancelación de eco ${status.echoCancellation ? 'activa' : 'NO disponible'} · ${status.sampleRate} Hz`);
    captureEchoCancelled = Boolean(status.echoCancellation);
    syncEchoMode();
    return;
  }
  // Capture in the window failed: Whisper opens the microphone itself, as before.
  log(`Micro con cancelación de eco no disponible (${status.error || 'error'}); uso el micro directo.`);
  captureMode = 'device';
  captureOn = false;
  captureEchoCancelled = false;
  syncEchoMode();
  const wasListening = stt?.listening;
  stt?.stop();
  stt?.ensure();
  if (wasListening) reconcileStt();
}

function registerIpc() {
  ipcMain.handle('agentcall:get-state', () => broker.getSnapshot());
  ipcMain.handle('agentcall:answer', (_e, id) => { log('UI: contestar'); return broker.answer(id); });
  ipcMain.handle('agentcall:snooze', (_e, { id, minutes }) => { log(`UI: posponer ${minutes} min`); return broker.snooze(id, minutes); });
  // Controlled call: what the user was still saying (its transcript may be a second away) goes to Claude
  // before the call leaves. Hook calls keep their own hang-up path (the words go to the session's queue).
  const leaveStream = async (id, reason) => {
    if (!broker.calls.get(id)?.stream || id !== broker.activeId) return;
    await voice.settle(1500);
    voice.flushDraft(reason);
  };
  ipcMain.handle('agentcall:hangup', async (_e, id) => { log('UI: colgar'); await leaveStream(id, 'cuelgas'); return broker.hangup(id); });
  ipcMain.handle('agentcall:hold', async (_e, id) => { log('UI: en espera'); await leaveStream(id, 'pones la llamada en espera'); return broker.hold(id); });
  ipcMain.handle('agentcall:dismiss', (_e, id) => { log('UI: terminar conversación'); return broker.dismiss(id); });
  ipcMain.handle('agentcall:set-dnd', (_e, value) => { log(`UI: DND ${value ? 'ON' : 'OFF'}`); broker.setDnd(value); return broker.dnd; });
  ipcMain.handle('agentcall:submit-choice', (_e, { id, choice }) => {
    log(`UI: botón ${Array.isArray(choice) ? choice.join(' + ') : choice}`);
    voice.clearDraft();
    const result = broker.submitChoice(id, choice);
    if (result?.ok && result.resolved !== false) voice.committed({ ok: true, route: 'answer', text: '' });
    return result;
  });
  ipcMain.handle('agentcall:submit-text', (_e, { id, text }) => {
    if (id !== broker.activeId) return { ok: false, error: 'Esta llamada ya no está activa.' };
    return voice.submitTyped(text);
  });
  ipcMain.handle('agentcall:adopt-draft', () => voice.adoptDraft());
  ipcMain.on('agentcall:set-typing', (_e, value) => voice.setTyping(value));
  ipcMain.on('agentcall:pcm', (_e, data) => stt?.writePcm(data));
  ipcMain.on('agentcall:capture-status', (_e, status) => onCaptureStatus(status));
  ipcMain.on('agentcall:tts-progress', (_e, event) => { if (event && typeof event === 'object') voice.tts(event); });
  ipcMain.handle('agentcall:voice-metrics', () => metrics.summary());
  ipcMain.handle('agentcall:start-stream', (_e, options) => startStreamCall(options && typeof options === 'object' ? options : {}));
  ipcMain.handle('agentcall:set-muted', (_e, value) => { log(`UI: micrófono ${value ? 'silenciado' : 'activo'}`); muted = Boolean(value); voice.setMuted(muted); reconcileStt(); return muted; });
  ipcMain.handle('agentcall:set-tts', (_e, value) => { ttsSpeaking = Boolean(value); reconcileStt(); return ttsSpeaking; });
  ipcMain.handle('agentcall:tts-speak', (_e, { id, text }) => tts.send({ cmd: 'speak', id, text }));
  ipcMain.handle('agentcall:tts-ack', (_e, id) => tts.send({ cmd: 'ack', id }));
  ipcMain.handle('agentcall:tts-stop', (_e, id) => tts.send({ cmd: 'stop', id: typeof id === 'string' ? id : null }));
  ipcMain.handle('agentcall:tts-engine', () => (tts.ready ? 'kokoro' : 'browser'));
  ipcMain.handle('agentcall:window-minimize', () => mainWindow?.minimize());
  ipcMain.handle('agentcall:window-hide', () => mainWindow?.hide());
  ipcMain.handle('agentcall:window-pin', (_e, value) => mainWindow?.setAlwaysOnTop(Boolean(value), 'floating'));
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('AgentCall');
  loadOperationalState();
  stt = new SttManager();
  prepareWinRtEngine();
  if (!whisperUnavailable) stt.ensure(); // warm up: load the Whisper model before the first call
  tts.start();
  registerIpc();
  createWindow();
  createTray();
  startHookServer();
  app.on('activate', () => showWindow({ focus: true }));
});

let streamsClosed = false;
app.on('before-quit', (event) => {
  // Controlled sessions are closed (or killed) before AgentCall goes: left alone, a Claude would go
  // on using tools with nobody on the call.
  if (streamCalls?.calls.size && !streamsClosed) {
    event.preventDefault();
    streamsClosed = true;
    streamCalls.closeAll().catch(() => {}).finally(() => app.quit());
    return;
  }
  quitting = true;
  stt?.stop();
  tts.stop();
  // Release every held hook so no Claude session stays blocked on a closed AgentCall.
  broker.releaseAll();
  if (server) server.close();
});

app.on('window-all-closed', (event) => {
  event?.preventDefault?.();
});
