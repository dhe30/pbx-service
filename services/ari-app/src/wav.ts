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

/**
 * Mix 8 kHz 16-bit mono WAVs (one per party of a call) into one: samples added, clipped to 16 bits,
 * as long as the longest input. Both parties' recordings start together, so they line up.
 */
export function mixWavs(inputs: Buffer[]): Buffer {
  const data = inputs.map(wavData);
  const samples = Math.max(0, ...data.map((d) => Math.floor(d.length / 2)));
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    let v = 0;
    for (const d of data) if (i * 2 + 1 < d.length) v += d.readInt16LE(i * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return Buffer.concat([wavHeader(out.length), out]);
}
