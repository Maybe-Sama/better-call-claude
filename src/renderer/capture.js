'use strict';
// Microphone capture with Chromium's echo cancellation (config "capture": "aec"). Claude's voice plays
// in this same window, so Chromium's canceller has it as reference and removes it from the microphone
// before Whisper hears it. Frames go to the main process (→ whisper_worker.py --source stdin); nothing
// is recorded. If capture fails, the main process falls back to the worker's own microphone input.
const agentCapture = (() => {
  let stream = null;
  let ctx = null;
  let node = null;
  let generation = 0; // a stop() during a pending start() makes that start obsolete
  const stats = { frames: 0, state: 'off' }; // diagnostics (window.agentCaptureStats)
  window.agentCaptureStats = stats;

  async function findDevice(wanted) {
    if (!wanted) return null;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hit = devices.find(d => d.kind === 'audioinput' && d.label.toLowerCase().includes(wanted.toLowerCase()));
    return hit ? hit.deviceId : null;
  }

  // Resolves with the status, or null if capture was stopped meanwhile (everything acquired is released).
  async function open({ mic, aec }, gen) {
    let s = null;
    let c = null;
    const live = () => gen === generation;
    const abandon = () => {
      try { s?.getTracks().forEach(t => t.stop()); } catch {}
      try { c?.close(); } catch {}
    };
    try {
      const audio = { echoCancellation: aec, noiseSuppression: aec, autoGainControl: false, channelCount: 1 };
      let deviceId = await findDevice(mic);
      s = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio });
      if (live() && mic && !deviceId) {
        // Device labels are only visible once the first permission has been granted.
        deviceId = await findDevice(mic);
        if (deviceId) {
          s.getTracks().forEach(t => t.stop());
          s = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } } });
        }
      }
      if (!live()) { abandon(); return null; }
      c = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
      await c.audioWorklet.addModule('capture-worklet.js');
      if (!live()) { abandon(); return null; }
      const source = c.createMediaStreamSource(s);
      const n = new AudioWorkletNode(c, 'agentcall-capture');
      n.port.onmessage = (e) => { stats.frames += 1; window.agentCall.sendPcm(e.data); };
      const sink = c.createGain();
      sink.gain.value = 0; // keeps the graph pulled without making a sound
      source.connect(n).connect(sink).connect(c.destination);
      const track = s.getAudioTracks()[0];
      track.onended = () => { if (live()) window.agentCall.captureStatus({ ok: false, error: 'El micrófono se ha desconectado.' }); };
      stats.state = c.state;
      c.onstatechange = () => { stats.state = c.state; };
      stream = s;
      ctx = c;
      node = n;
      const settings = track.getSettings();
      return { ok: true, label: track.label, echoCancellation: Boolean(settings.echoCancellation), sampleRate: c.sampleRate };
    } catch (err) {
      abandon();
      throw err;
    }
  }

  function start(options) {
    if (stream) return;
    generation += 1;
    const gen = generation;
    open(options, gen)
      .then(status => { if (status && gen === generation) window.agentCall.captureStatus(status); })
      .catch(err => { if (gen === generation) window.agentCall.captureStatus({ ok: false, error: err.message || String(err) }); });
  }

  function stop() {
    generation += 1;
    try { node?.port.close(); node?.disconnect(); } catch {}
    try { stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { ctx?.close(); } catch {}
    node = null;
    stream = null;
    ctx = null;
    stats.state = 'off';
  }

  window.agentCall.onCapture(cmd => {
    if (cmd.on) start(cmd);
    else stop();
  });
  return { start, stop };
})();
