// Asterisk writes "wav" recordings as 8 kHz, 16-bit, mono PCM with a 44-byte header.
const WAV_HEADER_BYTES = 44;
const BYTES_PER_SECOND = 8000 * 2;

export function wavDurationMs(fileSizeBytes: number): number {
  return Math.max(0, Math.round(((fileSizeBytes - WAV_HEADER_BYTES) / BYTES_PER_SECOND) * 1000));
}

/** The sample bytes of a PCM WAV (its "data" chunk), or the bytes after a 44-byte header. */
export function wavData(buf: Buffer): Buffer {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, Math.min(buf.length, off + 8 + len));
    off += 8 + len + (len % 2);
  }
  return buf.subarray(Math.min(buf.length, WAV_HEADER_BYTES));
}

/** 44-byte header of an 8 kHz, 16-bit, mono PCM WAV holding `dataBytes` of samples. */
export function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(8000, 24); // sample rate
  h.writeUInt32LE(BYTES_PER_SECOND, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** The samples of little-endian 16-bit PCM bytes (copied only when not 2-byte aligned). */
function samplesOf(bytes: Buffer): Int16Array {
  const n = Math.floor(bytes.length / 2);
  if (bytes.byteOffset % 2 === 0) return new Int16Array(bytes.buffer, bytes.byteOffset, n);
  const copy = Buffer.from(bytes.subarray(0, n * 2));
  return new Int16Array(copy.buffer, copy.byteOffset, n);
}

/** Samples mixed per slice by mixWavsAsync: ~4 s of audio, a few milliseconds of work at most. */
export const MIX_SLICE_SAMPLES = 1 << 15;

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Mix {
  data: Int16Array[];
  out: Buffer;
  view: Int16Array;
  samples: number;
}

function startMix(inputs: Buffer[]): Mix {
  const data = inputs.map((b) => samplesOf(wavData(b)));
  const samples = Math.max(0, ...data.map((d) => d.length));
  const out = Buffer.alloc(wavHeader(0).length + samples * 2);
  wavHeader(samples * 2).copy(out, 0);
  return { data, out, view: samplesOf(out.subarray(wavHeader(0).length)), samples };
}

function mixSlice(m: Mix, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    let v = 0;
    for (const d of m.data) if (i < d.length) v += d[i]!;
    m.view[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
}

/**
 * Mix 8 kHz 16-bit mono WAVs (one per party of a call) into one: samples added, clipped to 16 bits,
 * as long as the longest input. Both parties' recordings start together, so they line up.
 */
export function mixWavs(inputs: Buffer[]): Buffer {
  const m = startMix(inputs);
  mixSlice(m, 0, m.samples);
  return m.out;
}

/**
 * mixWavs in slices, yielding to the event loop between them. The ARI app mixes every recorded call
 * on the thread that runs all calls: mixing a long recording in one go (a 35-minute call is 17 M
 * samples per party) stalled the event loop for up to 1.3 s (2026-11-27), delaying every call on
 * the node (transfers, ring timers, prompts).
 */
export async function mixWavsAsync(inputs: Buffer[], yieldNow: () => Promise<void> = nextTick): Promise<Buffer> {
  const m = startMix(inputs);
  for (let from = 0; from < m.samples; from += MIX_SLICE_SAMPLES) {
    mixSlice(m, from, Math.min(m.samples, from + MIX_SLICE_SAMPLES));
    await yieldNow();
  }
  return m.out;
}
