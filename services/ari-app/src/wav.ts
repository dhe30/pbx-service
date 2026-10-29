// Asterisk writes "wav" recordings as 8 kHz, 16-bit, mono PCM with a 44-byte header.
const WAV_HEADER_BYTES = 44;
const BYTES_PER_SECOND = 8000 * 2;

export function wavDurationMs(fileSizeBytes: number): number {
  return Math.max(0, Math.round(((fileSizeBytes - WAV_HEADER_BYTES) / BYTES_PER_SECOND) * 1000));
}
