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
  // Voice conversation (src/voice/conversation.js runs in the main process).
  adoptDraft: () => ipcRenderer.invoke('agentcall:adopt-draft'),
  setTyping: (value) => ipcRenderer.send('agentcall:set-typing', Boolean(value)),
  ttsProgress: (event) => ipcRenderer.send('agentcall:tts-progress', event),
  voiceMetrics: () => ipcRenderer.invoke('agentcall:voice-metrics'),
  startStream: (options) => ipcRenderer.invoke('agentcall:start-stream', options),
  onVoice: (callback) => ipcRenderer.on('agentcall:voice', (_event, data) => callback(data)),
  onVoiceUi: (callback) => ipcRenderer.on('agentcall:voice-ui', (_event, data) => callback(data)),
  // Echo-cancelled microphone capture (src/renderer/capture.js).
  sendPcm: (buffer) => ipcRenderer.send('agentcall:pcm', buffer),
  captureStatus: (status) => ipcRenderer.send('agentcall:capture-status', status),
  onCapture: (callback) => ipcRenderer.on('agentcall:capture', (_event, cmd) => callback(cmd)),
  onTts: (callback) => ipcRenderer.on('agentcall:tts', (_event, data) => callback(data)),
  onState: (callback) => ipcRenderer.on('agentcall:state', (_event, state) => callback(state)),
  onStt: (callback) => ipcRenderer.on('agentcall:stt', (_event, data) => callback(data)),
  onServiceError: (callback) => ipcRenderer.on('agentcall:service-error', (_event, message) => callback(message)),
});
