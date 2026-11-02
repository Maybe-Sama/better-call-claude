'use strict';
// Microphone capture with Chromium's echo cancellation (config "capture": "aec"). Claude's voice plays
// in this same window, so Chromium's canceller has it as reference and removes it from the microphone
// before Whisper hears it. Frames go to the main process (→ whisper_worker.py --source stdin); nothing
// is recorded. If capture fails, the main process falls back to the worker's own microphone input.
const agentCapture = (() => {
  let stream = null;
  let ctx = null;
  let node = null;
  let starting = null;
  const stats = { frames: 0, state: 'off' }; // diagnostics (window.agentCaptureStats)
  window.agentCaptureStats = stats;

  async function findDevice(wanted) {
    if (!wanted) return null;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hit = devices.find(d => d.kind === 'audioinput' && d.label.toLowerCase().includes(wanted.toLowerCase()));
    return hit ? hit.deviceId : null;
  }

  async function open({ mic, aec }) {
    const audio = { echoCancellation: aec, noiseSuppression: aec, autoGainControl: false, channelCount: 1 };
    let deviceId = await findDevice(mic);
    stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio });
    if (mic && !deviceId) {
      // Device labels are only visible once the first permission has been granted.
      deviceId = await findDevice(mic);
      if (deviceId) {
        stream.getTracks().forEach(t => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } } });
      }
    }
    ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('capture-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'agentcall-capture');
    node.port.onmessage = (e) => { stats.frames += 1; window.agentCall.sendPcm(e.data); };
    const sink = ctx.createGain();
    sink.gain.value = 0; // keeps the graph pulled without making a sound
    source.connect(node).connect(sink).connect(ctx.destination);
    const track = stream.getAudioTracks()[0];
    track.onended = () => window.agentCall.captureStatus({ ok: false, error: 'El micrófono se ha desconectado.' });
    const settings = track.getSettings();
    stats.state = ctx.state;
    ctx.onstatechange = () => { stats.state = ctx?.state || 'closed'; };
    return { ok: true, label: track.label, echoCancellation: Boolean(settings.echoCancellation), sampleRate: ctx.sampleRate };
  }

  async function start(options) {
    if (stream) return;
    if (starting) return starting;
    starting = open(options)
      .then(status => window.agentCall.captureStatus(status))
      .catch(err => { stop(); window.agentCall.captureStatus({ ok: false, error: err.message || String(err) }); })
      .finally(() => { starting = null; });
    return starting;
  }

  function stop() {
    try { node?.port.close(); node?.disconnect(); } catch {}
    try { stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { ctx?.close(); } catch {}
    node = null;
    stream = null;
    ctx = null;
  }

  window.agentCall.onCapture(cmd => {
    if (cmd.on) start(cmd);
    else stop();
  });
  return { start, stop };
})();
