// the-pack voice — DownlinkPacer (verbatim port from beast-super-app; S1 jitter
// lesson: xAI bursts, SFU needs exact real-time 20ms cadence).
import {
  PACER_CAPACITY_MS, PACER_FRAME_MS, PACER_PREFILL_MS, PACER_UNDERFLOW_TOLERANCE_FRAMES, SFU_CHANNELS, SFU_RATE,
} from "./config.js";
import { frameBytes, silenceFrame } from "./pcm.js";

export class DownlinkPacer {
  constructor(opts = {}) {
    this.frameMs = opts.frameMs ?? PACER_FRAME_MS;
    const prefillMs = opts.prefillMs ?? PACER_PREFILL_MS;
    const capacityMs = opts.capacityMs ?? PACER_CAPACITY_MS;
    const rate = opts.rate ?? SFU_RATE;
    const channels = opts.channels ?? SFU_CHANNELS;
    if (prefillMs <= 0 || capacityMs <= 0 || this.frameMs <= 0) throw new Error("durations must be positive");
    if (capacityMs < prefillMs) throw new Error("capacityMs must be >= prefillMs");
    this.frameByteLen = frameBytes(rate, channels, this.frameMs);
    this.prefillFrames = Math.floor(prefillMs / this.frameMs);
    this.capacityFrames = Math.floor(capacityMs / this.frameMs);
    this.underflowTolerance = opts.underflowToleranceFrames ?? PACER_UNDERFLOW_TOLERANCE_FRAMES;
    this.silence = silenceFrame(this.frameByteLen);
    this.queue = [];
    this.started = false;
    this.underflowRun = 0;
    this.stats = { pushed: 0, popped: 0, droppedOldest: 0, underflows: 0, silenceSent: 0, flushes: 0 };
  }
  get bufferedFrames() {
    return this.queue.length;
  }
  get bufferedMs() {
    return this.queue.length * this.frameMs;
  }
  push(frame) {
    if (frame.length !== this.frameByteLen) {
      throw new Error(`frame must be ${this.frameByteLen} bytes (${this.frameMs} ms)`);
    }
    if (this.queue.length >= this.capacityFrames) {
      this.queue.shift();
      this.stats.droppedOldest++;
    }
    this.queue.push(frame);
    this.stats.pushed++;
  }
  pop() {
    if (!this.started) {
      if (this.queue.length < this.prefillFrames) return null;
      this.started = true;
    }
    const frame = this.queue.shift();
    if (frame) {
      this.underflowRun = 0;
      this.stats.popped++;
      return frame;
    }
    this.stats.underflows++;
    this.underflowRun++;
    if (this.underflowRun > this.underflowTolerance) {
      this.started = false;
      this.underflowRun = 0;
      return null;
    }
    this.stats.silenceSent++;
    return this.silence;
  }
  flush() {
    this.queue = [];
    this.started = false;
    this.underflowRun = 0;
    this.stats.flushes++;
  }
}
