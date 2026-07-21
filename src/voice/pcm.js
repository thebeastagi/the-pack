// the-pack voice — PCM16-LE helpers (verbatim port from beast-super-app, proven live).
// 48 kHz both ends, NO resampling; channel mapping + multi-seat mixing only.
import { SAMPLE_WIDTH_BYTES } from "./config.js";

export function frameBytes(rate, channels, ms) {
  return (rate * channels * SAMPLE_WIDTH_BYTES * ms) / 1000;
}

/** Stereo interleaved -> mono (average L/R). */
export function stereoToMono(stereo) {
  const frames = Math.floor(stereo.length / 4);
  const out = new Uint8Array(frames * 2);
  const dv = new DataView(stereo.buffer, stereo.byteOffset, stereo.byteLength);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < frames; i++) {
    const l = dv.getInt16(i * 4, true);
    const r = dv.getInt16(i * 4 + 2, true);
    odv.setInt16(i * 2, ((l + r) / 2) | 0, true);
  }
  return out;
}

/** Mono -> stereo (duplicate channel). */
export function monoToStereo(mono) {
  const frames = Math.floor(mono.length / 2);
  const out = new Uint8Array(frames * 4);
  const dv = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < frames; i++) {
    const v = dv.getInt16(i * 2, true);
    odv.setInt16(i * 4, v, true);
    odv.setInt16(i * 4 + 2, v, true);
  }
  return out;
}

/** Mix N mono PCM16 buffers into one (int16 sum, hard clamp). Missing/null
 * inputs count as silence. Lengths must match the first non-null buffer. */
export function mixMono(buffers, length) {
  const out = new Int32Array(length / 2); // accumulate wide — clamp only at the end
  for (const buf of buffers) {
    if (!buf) continue;
    const dv = new DataView(buf.buffer, buf.byteOffset, Math.min(buf.length, length));
    const n = Math.floor(dv.byteLength / 2);
    for (let i = 0; i < n; i++) out[i] += dv.getInt16(i * 2, true);
  }
  const bytes = new Uint8Array(length);
  const odv = new DataView(bytes.buffer);
  for (let i = 0; i < out.length; i++) {
    const v = Math.max(-32768, Math.min(32767, out[i]));
    odv.setInt16(i * 2, v, true);
  }
  return bytes;
}

/** Accumulate a byte stream and emit fixed-size chunks. */
export class Chunker {
  constructor(chunkSize) {
    if (chunkSize <= 0) throw new Error("chunkSize must be positive");
    this.chunkSize = chunkSize;
    this.buf = new Uint8Array(0);
  }
  feed(data) {
    const merged = new Uint8Array(this.buf.length + data.length);
    merged.set(this.buf, 0);
    merged.set(data, this.buf.length);
    const out = [];
    let pos = 0;
    while (pos + this.chunkSize <= merged.length) {
      out.push(merged.slice(pos, pos + this.chunkSize));
      pos += this.chunkSize;
    }
    this.buf = merged.slice(pos);
    return out;
  }
  flush() {
    if (this.buf.length === 0) return null;
    const out = new Uint8Array(this.chunkSize);
    out.set(this.buf, 0);
    this.buf = new Uint8Array(0);
    return out;
  }
  get pending() {
    return this.buf.length;
  }
}

export function silenceFrame(bytes) {
  return new Uint8Array(bytes);
}
