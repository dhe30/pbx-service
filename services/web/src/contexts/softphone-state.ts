import { createContext } from "react";

export type ConnectionStatus = "offline" | "connecting" | "online" | "reconnecting" | "error";
export type CallStatus = "ringing" | "answering" | "calling" | "connected";

export interface SoftphoneCallInfo {
    direction: "incoming" | "outgoing";
    remoteName: string;
    remoteUri: string;
    status: CallStatus;
    muted: boolean;
}

export interface SoftphoneContextValue {
    connectionStatus: ConnectionStatus;
    connectionRequested: boolean;
    connectionError: string | null;
    call: SoftphoneCallInfo | null;
    callError: string | null;
    connect: (extensionId?: string) => Promise<void>;
    disconnect: () => Promise<void>;
    makeCall: (number: string) => Promise<void>;
    answerCall: () => Promise<void>;
    declineCall: () => Promise<void>;
    hangUp: () => Promise<void>;
    toggleMute: () => void;
    sendDtmf: (digit: string) => void;
    resumeAudio: () => Promise<void>;
}

export const SoftphoneContext = createContext<SoftphoneContextValue | null>(null);
