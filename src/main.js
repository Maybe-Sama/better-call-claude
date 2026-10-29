'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CallBroker, MIN_RESULT_TURN_MS } = require('./broker');
const { readSessionTitle } = require('./session-title');

// Optional user settings in %LOCALAPPDATA%AgentCallconfig.json, e.g.
//   {"mic": "IN 1 (BEHRINGER", "voice": "ef_dora", "whisperModel": "small", "vocab": "Eureka, Supabase"}
// Environment variables still win, so a one-off run can override them.
const CONFIG_KEYS = {
  mic: 'AGENTCALL_MIC', voice: 'AGENTCALL_TTS_VOICE', ttsEngine: 'AGENTCALL_TTS_ENGINE', sttEngine: 'AGENTCALL_STT_ENGINE',
  whisperModel: 'AGENTCALL_WHISPER_MODEL', whisperPartialModel: 'AGENTCALL_WHISPER_PARTIAL_MODEL', vocab: 'AGENTCALL_STT_VOCAB',
  minResultSeconds: 'AGENTCALL_MIN_RESULT_SECONDS', port: 'AGENTCALL_PORT',
  ttsProvider: 'AGENTCALL_TTS_PROVIDER', edgeVoice: 'AGENTCALL_EDGE_VOICE', edgeRate: 'AGENTCALL_EDGE_RATE',
  micGain: 'AGENTCALL_MIC_GAIN', speechThreshold: 'AGENTCALL_SPEECH_THRESHOLD', whisperBackend: 'AGENTCALL_WHISPER_BACKEND',
};
try {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA || '', 'AgentCall', 'config.json'), 'utf8'));
  for (const [key, env] of Object.entries(CONFIG_KEYS)) {
    if (config[key] != null && process.env[env] == null) process.env[env] = String(config[key]);
  }
} catch { /* no config file: defaults */ }

const HOST = '127.0.0.1';
const PORT = Number(process.env.AGENTCALL_PORT || 32147);
const MIN_RESULT_MS = process.env.AGENTCALL_MIN_RESULT_SECONDS != null
  ? Number(process.env.AGENTCALL_MIN_RESULT_SECONDS) * 1000
  : MIN_RESULT_TURN_MS;
const VERSION = require('../package.json').version;

const broker = new CallBroker({ minResultMs: MIN_RESULT_MS, readTitle: readSessionTitle });

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
    broker.dnd = Boolean(saved.dnd);
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
  const ringing = snapshot.calls.some(c => c.status === 'ringing');
  if (detail.event === 'ringing') showWindow({ onTop: true });
  else if (detail.event === 'active') showWindow({ focus: true, onTop: true });
  else if (!active && !ringing && mainWindow?.isAlwaysOnTop()) mainWindow.setAlwaysOnTop(false);

  reconcileStt(active);
});

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
    respond(body) {
      if (done) return;
      done = true;
      log(`${label} → ${JSON.stringify(body || {}).slice(0, 160)}`);
      jsonResponse(res, 200, body || {});
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

  switch (url) {
    case '/hooks/user-prompt-submit':
      broker.notePrompt(body);
      return jsonResponse(res, 200, {});

    case '/hooks/post-tool-use':
      broker.noteToolDone(body);
      return jsonResponse(res, 200, {});

    case '/hooks/ask-user': {
      log(`AskUserQuestion [${session}]`);
      const hook = holdHook(res, `AskUserQuestion [${session}]`);
      hook.bind(broker.receiveAskUser(body, hook.respond));
      return;
    }

    case '/hooks/permission': {
      log(`PermissionRequest ${body.tool_name} [${session}]`);
      const hook = holdHook(res, `PermissionRequest [${session}]`);
      hook.bind(broker.receivePermission(body, hook.respond));
      return;
    }

    case '/hooks/stop': {
      log(`Stop [${session}] stop_hook_active=${Boolean(body.stop_hook_active)}`);
      const hook = holdHook(res, `Stop [${session}]`);
      hook.bind(broker.receiveCompletion(body, { responder: hook.respond }));
      return;
    }

    case '/hooks/stop-failure':
      log(`StopFailure [${session}] ${body.error || ''}`);
      broker.receiveCompletion(body, { failure: true });
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
  server.listen(PORT, HOST, () => log(`Escuchando en http://${HOST}:${PORT}`));
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
let whisperUnavailable = !['auto', 'whisper'].includes(STT_ENGINE) || !fs.existsSync(WHISPER_PYTHON);
let winrtExe = null;
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
      child = spawn(WHISPER_PYTHON, ['-u', path.join(__dirname, 'speech', 'whisper_worker.py'),
        '--language', STT_CULTURE.split('-')[0], '--models-dir', path.join(AGENTCALL_DATA, 'models')],
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
        if (event.type === 'ready') { this.ready = true; log(`TTS: ${event.engine} listo (voz ${event.voice})`); }
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

// The microphone opens as soon as the call is answered and stays open while Claude speaks
// (Claude is never interrupted: the renderer holds the answer until Claude finishes and filters its echo).
// Recognition context for the active call: the question and its options, or the key terms of Claude's message.
function sttContextFor(call) {
  const last = [...(call.messages || [])].reverse().find(m => m.role === 'assistant');
  if (!last) return null;
  const text = String(last.text || '');
  let hotwords = [];
  if (call.interactionKind === 'ask') {
    hotwords = text.split('\n').map(l => /^\d+\.\s+(.+?)(\s+—\s+|$)/.exec(l)?.[1]).filter(Boolean)
      .map(label => label.replace(/\s*\([^)]*\)\s*/g, ' ').trim());
  } else if (call.interactionKind === 'permission') {
    hotwords = ['sí', 'no', 'adelante', 'vale'];
  }
  // Proper nouns, camelCase identifiers and file names from Claude's message ("Vercel", "NextAuth", "app.js").
  const terms = text.match(/\b(?:[A-ZÁÉÍÓÚÑ][\w.+#-]*[A-Za-z0-9]|[a-z]+[A-Z]\w*|[\w-]+\.(?:js|ts|tsx|py|md|json|mp4|html|css))\b/g) || [];
  hotwords = [...new Set([...hotwords, ...terms.filter(t => t.length > 2)])].slice(0, 24);
  // Numbered option lists in the prompt make Whisper echo the numbers ("4. NextAuth"): send plain prose.
  const prose = call.interactionKind === 'ask'
    ? `${text.split('\n')[0]} ${hotwords.slice(0, 6).join(', ')}.`
    : text.replace(/^\s*\d+[.)]\s+/gm, '');
  return { text: prose.replace(/\s+/g, ' ').slice(0, 400), hotwords: hotwords.join(', ') };
}

function reconcileStt(active = activeCall()) {
  if (!stt) return;
  if (!active) return stt.idle();
  stt.ensure();
  stt.setContext(sttContextFor(active));
  const canAnswer = ['ask', 'permission', 'stop'].includes(active.interactionKind) && active.waiting && !active.awaitingClaude;
  stt.setListening(Boolean(canAnswer && !muted));
}

function registerIpc() {
  ipcMain.handle('agentcall:get-state', () => broker.getSnapshot());
  ipcMain.handle('agentcall:answer', (_e, id) => { log('UI: contestar'); return broker.answer(id); });
  ipcMain.handle('agentcall:snooze', (_e, { id, minutes }) => { log(`UI: posponer ${minutes} min`); return broker.snooze(id, minutes); });
  ipcMain.handle('agentcall:hangup', (_e, id) => { log('UI: colgar'); return broker.hangup(id); });
  ipcMain.handle('agentcall:set-dnd', (_e, value) => { log(`UI: DND ${value ? 'ON' : 'OFF'}`); broker.setDnd(value); return broker.dnd; });
  ipcMain.handle('agentcall:submit-text', (_e, { id, text }) => { log(`UI: respuesta (${String(text).length} caracteres)`); return broker.submitUserText(id, text); });
  ipcMain.handle('agentcall:set-muted', (_e, value) => { log(`UI: micrófono ${value ? 'silenciado' : 'activo'}`); muted = Boolean(value); reconcileStt(); return muted; });
  ipcMain.handle('agentcall:set-tts', (_e, value) => { ttsSpeaking = Boolean(value); reconcileStt(); return ttsSpeaking; });
  ipcMain.handle('agentcall:tts-speak', (_e, { id, text }) => tts.send({ cmd: 'speak', id, text }));
  ipcMain.handle('agentcall:tts-ack', (_e, id) => tts.send({ cmd: 'ack', id }));
  ipcMain.handle('agentcall:tts-stop', () => tts.send({ cmd: 'stop' }));
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

app.on('before-quit', () => {
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
