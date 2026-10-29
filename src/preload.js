'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentCall', {
  getState: () => ipcRenderer.invoke('agentcall:get-state'),
  answer: (id) => ipcRenderer.invoke('agentcall:answer', id),
  snooze: (id, minutes) => ipcRenderer.invoke('agentcall:snooze', { id, minutes }),
  hangup: (id) => ipcRenderer.invoke('agentcall:hangup', id),
  setDnd: (value) => ipcRenderer.invoke('agentcall:set-dnd', value),
  submitChoice: (id, choice) => ipcRenderer.invoke('agentcall:submit-choice', { id, choice }),
  submitText: (id, text) => ipcRenderer.invoke('agentcall:submit-text', { id, text }),
  setMuted: (value) => ipcRenderer.invoke('agentcall:set-muted', value),
  setTts: (value) => ipcRenderer.invoke('agentcall:set-tts', value),
  minimize: () => ipcRenderer.invoke('agentcall:window-minimize'),
  hide: () => ipcRenderer.invoke('agentcall:window-hide'),
  pin: (value) => ipcRenderer.invoke('agentcall:window-pin', value),
  ttsSpeak: (id, text) => ipcRenderer.invoke('agentcall:tts-speak', { id, text }),
  ttsAck: (id) => ipcRenderer.invoke('agentcall:tts-ack', id),
  ttsStop: () => ipcRenderer.invoke('agentcall:tts-stop'),
  getTtsEngine: () => ipcRenderer.invoke('agentcall:tts-engine'),
  onTts: (callback) => ipcRenderer.on('agentcall:tts', (_event, data) => callback(data)),
  onState: (callback) => ipcRenderer.on('agentcall:state', (_event, state) => callback(state)),
  onStt: (callback) => ipcRenderer.on('agentcall:stt', (_event, data) => callback(data)),
  onServiceError: (callback) => ipcRenderer.on('agentcall:service-error', (_event, message) => callback(message)),
});
