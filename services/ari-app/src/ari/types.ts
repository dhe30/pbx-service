// Minimal typed subset of the Asterisk REST Interface (ARI) used by this app.
// Reference: https://docs.asterisk.org/Latest_API/API_Documentation/Asterisk_REST_Interface/

export interface Channel {
  id: string;
  name: string;
  state: string; // 'Down' | 'Ring' | 'Ringing' | 'Up' | ...
  caller: { name: string; number: string };
  connected: { name: string; number: string };
  dialplan: { context: string; exten: string; priority: number; app_name?: string; app_data?: string };
}

export interface Playback {
  id: string;
  media_uri: string;
  target_uri: string;
  state: 'queued' | 'playing' | 'continuing' | 'done' | 'failed';
}

export interface LiveRecording {
  name: string;
  format: string;
  target_uri: string;
  state: 'queued' | 'recording' | 'paused' | 'done' | 'failed' | 'canceled';
  duration?: number; // seconds
  cause?: string;
}

export interface Bridge {
  id: string;
  bridge_type: string;
  channels: string[];
}

interface EventBase {
  application: string;
  timestamp: string;
}

export interface StasisStart extends EventBase {
  type: 'StasisStart';
  args: string[];
  channel: Channel;
}
export interface StasisEnd extends EventBase {
  type: 'StasisEnd';
  channel: Channel;
}
export interface ChannelDtmfReceived extends EventBase {
  type: 'ChannelDtmfReceived';
  digit: string;
  duration_ms: number;
  channel: Channel;
}
export interface ChannelHangupRequest extends EventBase {
  type: 'ChannelHangupRequest';
  cause?: number;
  channel: Channel;
}
export interface ChannelDestroyed extends EventBase {
  type: 'ChannelDestroyed';
  cause: number;
  cause_txt: string;
  channel: Channel;
}
export interface ChannelStateChange extends EventBase {
  type: 'ChannelStateChange';
  channel: Channel;
}
/** The channel's far end put us on hold (re-INVITE a=sendonly/inactive or c=0.0.0.0). */
export interface ChannelHold extends EventBase {
  type: 'ChannelHold';
  musicclass?: string;
  channel: Channel;
}
export interface ChannelUnhold extends EventBase {
  type: 'ChannelUnhold';
  channel: Channel;
}
export interface PlaybackFinished extends EventBase {
  type: 'PlaybackFinished';
  playback: Playback;
}
export interface RecordingFinished extends EventBase {
  type: 'RecordingFinished';
  recording: LiveRecording;
}
export interface RecordingFailed extends EventBase {
  type: 'RecordingFailed';
  recording: LiveRecording;
}
// Other event types arrive too; code switches on `type` and ignores the rest.
export type AriEvent =
  | StasisStart
  | StasisEnd
  | ChannelDtmfReceived
  | ChannelHangupRequest
  | ChannelDestroyed
  | ChannelStateChange
  | ChannelHold
  | ChannelUnhold
  | PlaybackFinished
  | RecordingFinished
  | RecordingFailed;

/** Hangup reasons accepted by DELETE /channels/{id}?reason=... (mapped to SIP codes by Asterisk). */
export type HangupReason =
  | 'normal'
  | 'busy'
  | 'congestion' // -> 503: lets Kamailio retry another pbx node
  | 'no_answer'
  | 'unallocated' // -> 404: unknown DID
  | 'failure';
