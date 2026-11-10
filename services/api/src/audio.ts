import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from './errors.js';

// Converts uploaded audio (greetings) to what Asterisk plays: WAV, 16-bit PCM, mono, 8 kHz
// (docs/telephony-contract.md §5, docs/split-contracts.md §6). Runs ffmpeg as a child process.
//
// Security: the upload is untrusted input to ffmpeg. Some ffmpeg input formats are playlists that
// open OTHER files or URLs (HLS, concat, ...), which would let a customer read files on the app
// node or make it fetch URLs. So only plain audio container formats are accepted
// (-format_whitelist), only local files can be opened (-protocol_whitelist file), and ffmpeg gets
// a time limit. Conversions are CPU work, so only a few run at once per process.

export interface ConvertedAudio {
  /** WAV file: RIFF header + 16-bit mono 8 kHz PCM. */
  wav: Buffer;
  durationMs: number;
}

export interface AudioConverter {
  /** Throws HttpError 400 `invalid_audio` if the input isn't audio or is too long. */
  toPhoneWav(input: Buffer, maxSeconds: number): Promise<ConvertedAudio>;
}

/** ffmpeg demuxers allowed for uploads: WAV, MP3, Ogg (Vorbis/Opus), FLAC, MP4/M4A, WebM/MKV, AAC, AIFF, CAF. */
const INPUT_FORMATS = 'wav,w64,mp3,ogg,flac,mov,matroska,aac,aiff,caf';
const SAMPLE_RATE = 8000;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // 16-bit mono

export class FfmpegConverter implements AudioConverter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly ffmpegPath = 'ffmpeg',
    private readonly opts: { maxConcurrent?: number; timeoutMs?: number } = {},
  ) {}

  async toPhoneWav(input: Buffer, maxSeconds: number): Promise<ConvertedAudio> {
    if (input.length === 0) throw invalidAudio('The upload is empty');
    await this.acquire();
    const dir = await mkdtemp(join(tmpdir(), 'pbx-audio-'));
    try {
      const inPath = join(dir, 'input'); // no extension: ffmpeg detects the format from the content
      const outPath = join(dir, 'output.wav');
      await writeFile(inPath, input);
      // Converts one second more than allowed, so "too long" can be told apart from "exactly the limit".
      await this.run([
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-protocol_whitelist', 'file',
        '-format_whitelist', INPUT_FORMATS,
        '-i', inPath,
        '-t', String(maxSeconds + 1),
        '-map', '0:a:0', // first audio stream; error if there is none
        '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le',
        // No metadata or encoder tags: a plain 44-byte WAV header like Asterisk's own recordings.
        '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
        '-f', 'wav', '-y', outPath,
      ]);
      const wav = await readFile(outPath);
      const durationMs = wavDurationMs(wav);
      if (durationMs === 0) throw invalidAudio('The upload contains no audio');
      if (durationMs > maxSeconds * 1000) throw invalidAudio(`Audio is longer than ${maxSeconds} seconds`);
      return { wav, durationMs };
    } finally {
      await rm(dir, { recursive: true, force: true });
      this.release();
    }
  }

  private run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 2000) stderr += d.toString();
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), this.opts.timeoutMs ?? 30_000);
      // Spawn failures (ffmpeg not installed) are a server problem: plain Error -> 500 + log.
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`ffmpeg failed to start (${this.ffmpegPath}): ${err.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        if (signal === 'SIGKILL') return reject(invalidAudio('Audio conversion took too long'));
        // Unreadable input. ffmpeg's message names the problem but also our temp paths; keep it short.
        const reason = stderr.split('\n').find((l) => l.trim())?.replace(/\/[^\s:]*/g, '<file>') ?? 'unknown error';
        reject(invalidAudio(`Not a supported audio file (${reason.trim().slice(0, 200)})`));
      });
    });
  }

  private async acquire(): Promise<void> {
    if (this.running < (this.opts.maxConcurrent ?? 2)) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); // hand the slot over; `running` stays the same
    else this.running--;
  }
}

const invalidAudio = (message: string) => new HttpError(400, 'invalid_audio', message);

/** Duration of 8 kHz 16-bit mono PCM in a WAV file, from the size of its `data` chunk. */
export function wavDurationMs(wav: Buffer): number {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('ffmpeg output is not a WAV file');
  }
  let pos = 12;
  while (pos + 8 <= wav.length) {
    const id = wav.toString('ascii', pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    if (id === 'data') {
      // A streamed WAV may carry a placeholder size; trust the bytes actually present.
      const bytes = Math.min(size, wav.length - pos - 8);
      return Math.round((bytes / BYTES_PER_SEC) * 1000);
    }
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error('ffmpeg output has no data chunk');
}
