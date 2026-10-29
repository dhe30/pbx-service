import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AriEvent, Bridge, Channel, HangupReason, LiveRecording, Playback } from './types.js';

// Thin typed ARI client: REST over fetch + one events WebSocket.
// We deliberately do NOT auto-reconnect the WebSocket. If it drops after being established the
// process exits and systemd restarts it (crash-only design: in-progress calls on this node are
// lost anyway, and a fresh process has no stale state). See index.ts.

export class AriError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`ARI ${method} ${path} -> ${status}: ${body.slice(0, 200)}`);
  }
  /** 404 = channel/bridge/playback is already gone; usually fine to ignore during cleanup. */
  get gone(): boolean {
    return this.status === 404;
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export interface AriClientOptions {
  url: string; // http://127.0.0.1:8088
  user: string;
  password: string;
  app: string;
  requestTimeoutMs?: number;
}

export interface AriClientEvents {
  event: [AriEvent];
  close: [reason: string];
}

export class AriClient extends EventEmitter<AriClientEvents> {
  private readonly auth: string;
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: AriClientOptions) {
    super();
    this.auth = 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64');
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Open the events WebSocket. Resolves once open; rejects if it can't connect. */
  connect(): Promise<void> {
    const url = new URL('/ari/events', this.opts.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('app', this.opts.app);
    url.searchParams.set('subscribeAll', 'false');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Authorization: this.auth } });
      let opened = false;
      let alive = true;

      ws.on('open', () => {
        opened = true;
        this.ws = ws;
        // Detect a silently dead connection (Asterisk hung, network blip): ping every 10 s and
        // give up if the previous ping got no pong.
        this.pingTimer = setInterval(() => {
          if (!alive) {
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
        }, 10_000);
        resolve();
      });
      ws.on('pong', () => {
        alive = true;
      });
      ws.on('message', (data) => {
        let ev: AriEvent;
        try {
          ev = JSON.parse(data.toString()) as AriEvent;
        } catch {
          return;
        }
        this.emit('event', ev);
      });
      ws.on('error', (err) => {
        if (!opened) reject(err);
      });
      ws.on('close', (code, reason) => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        this.ws = null;
        if (opened) this.emit('close', `${code} ${reason.toString()}`);
        else reject(new Error(`ARI WebSocket closed before open (${code})`));
      });
    });
  }

  close(): void {
    this.ws?.close();
  }

  // ---- REST --------------------------------------------------------------------------------

  async request<T>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
    const url = new URL(`/ari${path}`, this.opts.url);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.auth,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 5000),
    });
    const text = await res.text();
    if (!res.ok) throw new AriError(res.status, method, path, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  listChannels(): Promise<Channel[]> {
    return this.request('GET', '/channels');
  }

  answer(channelId: string): Promise<void> {
    return this.request('POST', `/channels/${enc(channelId)}/answer`);
  }

  hangup(channelId: string, reason: HangupReason = 'normal'): Promise<void> {
    return this.request('DELETE', `/channels/${enc(channelId)}`, { reason });
  }

  /** Hang up, ignoring "already gone". */
  async hangupQuietly(channelId: string, reason: HangupReason = 'normal'): Promise<void> {
    try {
      await this.hangup(channelId, reason);
    } catch (err) {
      if (!(err instanceof AriError && err.gone)) throw err;
    }
  }

  play(channelId: string, media: string, playbackId: string): Promise<Playback> {
    return this.request('POST', `/channels/${enc(channelId)}/play`, { media, playbackId });
  }

  async stopPlayback(playbackId: string): Promise<void> {
    try {
      await this.request('DELETE', `/playbacks/${enc(playbackId)}`);
    } catch (err) {
      if (!(err instanceof AriError && err.gone)) throw err;
    }
  }

  /** Music on hold to one channel. Works while it is bridged: it replaces the bridge audio. */
  startMoh(channelId: string, mohClass: string): Promise<void> {
    return this.request('POST', `/channels/${enc(channelId)}/moh`, { mohClass });
  }

  async stopMoh(channelId: string): Promise<void> {
    try {
      await this.request('DELETE', `/channels/${enc(channelId)}/moh`);
    } catch (err) {
      if (!(err instanceof AriError && err.gone)) throw err;
    }
  }

  recordChannel(
    channelId: string,
    opts: { name: string; maxDurationSeconds: number; maxSilenceSeconds: number; beep: boolean; terminateOn: string },
  ): Promise<LiveRecording> {
    return this.request('POST', `/channels/${enc(channelId)}/record`, {
      ...opts,
      format: 'wav',
      ifExists: 'overwrite',
    });
  }

  originate(opts: {
    endpoint: string;
    channelId: string;
    appArgs: string;
    callerId?: string;
    timeout: number;
    originator?: string;
  }): Promise<Channel> {
    return this.request('POST', '/channels', { ...opts, app: this.opts.app });
  }

  createBridge(bridgeId: string): Promise<Bridge> {
    return this.request('POST', '/bridges', { type: 'mixing', bridgeId });
  }

  addToBridge(bridgeId: string, channelIds: string[]): Promise<void> {
    return this.request('POST', `/bridges/${enc(bridgeId)}/addChannel`, { channel: channelIds.join(',') });
  }

  async destroyBridge(bridgeId: string): Promise<void> {
    try {
      await this.request('DELETE', `/bridges/${enc(bridgeId)}`);
    } catch (err) {
      if (!(err instanceof AriError && err.gone)) throw err;
    }
  }

  recordBridge(bridgeId: string, name: string): Promise<LiveRecording> {
    return this.request('POST', `/bridges/${enc(bridgeId)}/record`, {
      name,
      format: 'wav',
      ifExists: 'overwrite',
      beep: false,
    });
  }

  async stopRecording(name: string): Promise<void> {
    try {
      await this.request('POST', `/recordings/live/${enc(name)}/stop`);
    } catch (err) {
      if (!(err instanceof AriError && err.gone)) throw err;
    }
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
