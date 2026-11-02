'use strict';
// Runs in the audio rendering thread: microphone samples (the AudioContext runs at 16 kHz) → int16
// frames of 30 ms posted to the page, which forwards them to the Whisper worker.
const FRAME = 480;

class AgentCallCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        const v = Math.max(-1, Math.min(1, channel[i]));
        this.frame[this.n] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.n += 1;
        if (this.n === FRAME) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(FRAME);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('agentcall-capture', AgentCallCapture);
