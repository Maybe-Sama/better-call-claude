'use strict';
// Runs in the audio rendering thread: microphone samples → 16 kHz int16 frames of 30 ms posted to the
// page, which forwards them to the Whisper worker. The AudioContext is created at 16 kHz; if the
// system gives another rate (`sampleRate` is the context's real rate), it is resampled here.
const TARGET_RATE = 16000;
const FRAME = 480;

class AgentCallCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(FRAME);
    this.n = 0;
    this.step = sampleRate / TARGET_RATE; // input samples per output sample
    this.pos = 1;                         // next output position between prev (0) and the current sample (1)
    this.prev = 0;
  }

  push(v) {
    const s = Math.max(-1, Math.min(1, v));
    this.frame[this.n] = s < 0 ? s * 0x8000 : s * 0x7fff;
    this.n += 1;
    if (this.n === FRAME) {
      this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
      this.frame = new Int16Array(FRAME);
      this.n = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    if (this.step === 1) {
      for (let i = 0; i < channel.length; i += 1) this.push(channel[i]);
      return true;
    }
    for (let i = 0; i < channel.length; i += 1) { // linear interpolation
      const cur = channel[i];
      while (this.pos <= 1) {
        this.push(this.prev + (cur - this.prev) * this.pos);
        this.pos += this.step;
      }
      this.pos -= 1;
      this.prev = cur;
    }
    return true;
  }
}

registerProcessor('agentcall-capture', AgentCallCapture);
