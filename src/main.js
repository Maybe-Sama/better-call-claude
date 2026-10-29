'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CallBroker } = require('./broker');

const HOST = '127.0.0.1';
const PORT = Number(process.env.AGENTCALL_PORT || 32147);
const broker = new CallBroker();

let mainWindow = null;
let tray = null;
let server = null;
let quitting = false;
let muted = false;
let ttsSpeaking = false;
let stt = null;

function stateFile() {
  return path.join(app.getPath('userData'), 'operational-state.json');
}

function persistOperationalState() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(broker.exportPersistentState(), null, 2), 'utf8');
  } catch (err) {
    console.error('[AgentCall] Could not persist state:', err.message);
  }
}

function loadOperationalState() {
  try {
    if (!fs.existsSync(stateFile())) return;
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    broker.dnd = Boolean(saved.dnd);
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
    alwaysOnTop: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'agentcall.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip('AgentCall');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir AgentCall', click: () => showWindow(false) },
    { type: 'separator' },
    { label: 'No molestar', type: 'checkbox', checked: broker.dnd, click: (item) => broker.setDnd(item.checked) },
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => showWindow(false));
}

function showWindow(forceTop = true) {
  if (!mainWindow) return;
  if (forceTop) mainWindow.setAlwaysOnTop(true, 'floating');
  if (!mainWindow.isVisible()) mainWindow.show();
  if (forceTop) {
    mainWindow.restore();
    mainWindow.focus();
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function activeCall() {
  const snapshot = broker.getSnapshot();
  return snapshot.calls.find(c => c.id === snapshot.activeId) || null;
}

broker.on('change', (snapshot, detail) => {
  persistOperationalState();
  sendToRenderer('agentcall:state', snapshot);

  if (detail.event === 'ringing') {
    showWindow(true);
  } else if (detail.event === 'message' || detail.event === 'active') {
    if (snapshot.activeId) showWindow(true);
  }

  const active = activeCall();
  if (!active) stopStt();
  else reconcileStt();
});

function jsonResponse(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  const payload = body == null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) {
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

function holdHookResponse(res) {
  let done = false;
  return (body) => {
    if (done) return;
    done = true;
    jsonResponse(res, 200, body || {});
  };
}

async function routeHook(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    return jsonResponse(res, 200, { ok: true, service: 'AgentCall', port: PORT, dnd: broker.dnd });
  }
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method_not_allowed' });

  let body;
  try { body = await readJson(req); }
  catch (err) { return jsonResponse(res, 400, { error: err.message }); }

  switch (req.url) {
    case '/hooks/user-prompt-submit':
      broker.updateTopic(body);
      return jsonResponse(res, 200, {});

    case '/hooks/ask-user': {
      const respond = holdHookResponse(res);
      broker.receiveAskUser(body, respond);
      return;
    }

    case '/hooks/permission': {
      const respond = holdHookResponse(res);
      broker.receivePermission(body, respond);
      return;
    }

    case '/hooks/stop': {
      const respond = holdHookResponse(res);
      broker.receiveCompletion(body, { responder: respond });
      return;
    }

    case '/hooks/stop-failure':
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
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.listen(PORT, HOST, () => console.log(`[AgentCall] Listening on http://${HOST}:${PORT}`));
  server.on('error', (err) => {
    console.error('[AgentCall] HTTP server failed:', err);
    sendToRenderer('agentcall:service-error', `No se pudo abrir el puerto ${PORT}: ${err.message}`);
  });
}

class SttManager {
  constructor() {
    this.child = null;
    this.buffer = '';
  }

  start() {
    if (process.platform !== 'win32' || this.child) return;
    const script = path.join(__dirname, 'speech', 'stt-worker.ps1');
    this.child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try { sendToRenderer('agentcall:stt', JSON.parse(line)); }
        catch { }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => console.error('[AgentCall STT]', text.trim()));
    this.child.on('exit', (code) => {
      this.child = null;
      if (code && code !== 0) sendToRenderer('agentcall:stt', { type: 'error', message: 'El reconocimiento de voz de Windows se ha detenido.' });
    });
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try { child.kill(); } catch { }
  }
}

function stopStt() { stt?.stop(); }
function reconcileStt() {
  const active = activeCall();
  const shouldListen = Boolean(active && !muted && !ttsSpeaking && ['ask', 'permission', 'stop'].includes(active.interactionKind) && !active.awaitingClaude);
  if (shouldListen) stt?.start(); else stt?.stop();
}

function registerIpc() {
  ipcMain.handle('agentcall:get-state', () => broker.getSnapshot());
  ipcMain.handle('agentcall:answer', (_e, id) => broker.answer(id));
  ipcMain.handle('agentcall:snooze', (_e, { id, minutes }) => broker.snooze(id, minutes));
  ipcMain.handle('agentcall:hangup', (_e, id) => broker.hangup(id));
  ipcMain.handle('agentcall:set-dnd', (_e, value) => { broker.setDnd(value); return broker.dnd; });
  ipcMain.handle('agentcall:submit-text', (_e, { id, text }) => broker.submitUserText(id, text));
  ipcMain.handle('agentcall:set-muted', (_e, value) => { muted = Boolean(value); reconcileStt(); return muted; });
  ipcMain.handle('agentcall:set-tts', (_e, value) => { ttsSpeaking = Boolean(value); reconcileStt(); return ttsSpeaking; });
  ipcMain.handle('agentcall:window-minimize', () => mainWindow?.minimize());
  ipcMain.handle('agentcall:window-hide', () => mainWindow?.hide());
  ipcMain.handle('agentcall:window-pin', (_e, value) => mainWindow?.setAlwaysOnTop(Boolean(value), 'floating'));
}

app.whenReady().then(() => {
  loadOperationalState();
  stt = new SttManager();
  registerIpc();
  createWindow();
  createTray();
  startHookServer();

  app.on('activate', () => showWindow(false));
});

app.on('before-quit', () => {
  quitting = true;
  stopStt();
  if (server) server.close();
});

app.on('window-all-closed', (event) => {
  event?.preventDefault?.();
});
