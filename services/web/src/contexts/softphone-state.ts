import { createContext } from "react";

export type ConnectionStatus = "offline" | "connecting" | "online" | "reconnecting" | "error";
export type CallStatus = "ringing" | "answering" | "calling" | "connected";

/**
 * One call ("line"). The softphone can hold several at once: call waiting (answering a second
 * call holds the first) and attended transfer (the original call held + a consultation call).
 * docs/telephony-contract.md §8, docs/hold-call-waiting.md.
 */
export interface SoftphoneLineInfo {
    id: number;
    direction: "incoming" | "outgoing";
    remoteName: string;
    remoteUri: string;
    status: CallStatus;
    /** We put this call on hold (re-INVITE a=sendonly). */
    held: boolean;
    /** A hold/resume re-INVITE or a REFER is in flight. */
    busy: boolean;
    muted: boolean;
    /** Attended transfer: the id of the held line this consultation call was placed for. */
    consultFor: number | null;
}

export interface SoftphoneContextValue {
    connectionStatus: ConnectionStatus;
    connectionError: string | null;
    /** Extension chosen in `softphone-extension` (id); registering starts as soon as it is set. */
    selectedExtensionId: string;
    selectExtension: (extensionId: string) => void;
    /** Extension number the phone is registered as (null while offline). */
    registeredNumber: string | null;
    /** Text in `softphone-number`: call target and transfer target. */
    number: string;
    setNumber: (value: string) => void;
    lines: SoftphoneLineInfo[];
    /** The established, un-held call (or the outgoing call still ringing out). */
    activeLine: SoftphoneLineInfo | null;
    /** The oldest incoming call still ringing. */
    ringingLine: SoftphoneLineInfo | null;
    canHangUp: boolean;
    canHold: boolean;
    canTransferBlind: boolean;
    canTransferAttended: boolean;
    canTransferComplete: boolean;
    callError: string | null;
    audioBlocked: boolean;
    disconnect: () => Promise<void>;
    makeCall: () => Promise<void>;
    answerCall: () => Promise<void>;
    declineCall: () => Promise<void>;
    hangUp: () => Promise<void>;
    toggleHold: () => Promise<void>;
    transferBlind: () => Promise<void>;
    transferAttended: () => Promise<void>;
    transferComplete: () => Promise<void>;
    toggleMute: () => void;
    sendDtmf: (digit: string) => void;
    resumeAudio: () => Promise<void>;
}

export const SoftphoneContext = createContext<SoftphoneContextValue | null>(null);
