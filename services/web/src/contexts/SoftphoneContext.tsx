import type { Invitation, Inviter, Registerer, Session, UserAgent } from "sip.js";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { fetchSipCredentials, type SipCredentials } from "../services/sip";
import { useAuth } from "../hooks/useAuth";
import { useSoftphone } from "../hooks/useSoftphone";
import {
    SoftphoneContext,
    type ConnectionStatus,
    type SoftphoneCallInfo,
    type SoftphoneContextValue,
} from "./softphone-state";

type SipModule = typeof import("sip.js");

interface CallDisplay {
    remoteName: SoftphoneCallInfo["remoteName"];
    remoteUri: SoftphoneCallInfo["remoteUri"];
    status: SoftphoneCallInfo["status"];
    muted: SoftphoneCallInfo["muted"];
}

type ActiveCall =
    | (CallDisplay & { session: Invitation; direction: "incoming" })
    | (CallDisplay & { session: Inviter; direction: "outgoing" });

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "An unexpected phone error occurred.";
}

function getPeerConnection(session: Session): RTCPeerConnection | null {
    const handler = session.sessionDescriptionHandler;
    if (!handler || !("peerConnection" in handler)) return null;
    return handler.peerConnection instanceof RTCPeerConnection
        ? handler.peerConnection
        : null;
}

export function SoftphoneProvider({ children }: { children: ReactNode }) {
    const { loggedIn } = useAuth();
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("offline");
    const [connectionRequested, setConnectionRequested] = useState(false);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
    const [callError, setCallError] = useState<string | null>(null);
    const userAgentRef = useRef<UserAgent | null>(null);
    const registererRef = useRef<Registerer | null>(null);
    const sipModuleRef = useRef<SipModule | null>(null);
    const credentialsRef = useRef<SipCredentials | null>(null);
    const callRef = useRef<ActiveCall | null>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const onlineRequestedRef = useRef(false);
    const retryCountRef = useRef(0);
    const retryTimerRef = useRef<number | null>(null);
    const mountedRef = useRef(true);
    const connectingRef = useRef(false);
    const connectAndRegisterRef = useRef<() => Promise<void>>(async () => {});

    const updateCall = useCallback((call: ActiveCall | null) => {
        callRef.current = call;
        if (mountedRef.current) setActiveCall(call);
    }, []);

    const setCallErrorIfMounted = useCallback((error: unknown) => {
        if (mountedRef.current) setCallError(errorMessage(error));
    }, []);

    const attachRemoteAudio = useCallback((session: Session) => {
        const peerConnection = getPeerConnection(session);
        const audio = audioRef.current;
        if (!peerConnection || !audio) return;

        const stream = new MediaStream();
        peerConnection.getReceivers().forEach((receiver) => {
            if (receiver.track?.kind === "audio") stream.addTrack(receiver.track);
        });
        audio.srcObject = stream;
        void audio.play().catch(() => {
            setCallErrorIfMounted(new Error("Audio playback was blocked. Use the call modal to resume audio."));
        });
    }, [setCallErrorIfMounted]);

    const watchSession = useCallback((session: Session) => {
        session.stateChange.addListener((state) => {
            if (state === "Established") {
                const current = callRef.current;
                if (current?.session === session) {
                    updateCall({ ...current, status: "connected" });
                    attachRemoteAudio(session);
                }
            } else if (state === "Terminated") {
                if (callRef.current?.session === session) {
                    updateCall(null);
                    if (audioRef.current) audioRef.current.srcObject = null;
                }
            }
        });
    }, [attachRemoteAudio, updateCall]);

    const handleInvite = useCallback((invitation: Invitation) => {
        if (callRef.current) {
            setCallError("Another call is active; the incoming call was declined.");
            void invitation.reject({ statusCode: 486 }).catch(setCallErrorIfMounted);
            return;
        }

        const uri = invitation.remoteIdentity.uri;
        const remoteUri = uri.toString();
        const remoteName = invitation.remoteIdentity.displayName || uri.user || "Unknown caller";
        const nextCall: ActiveCall = {
            session: invitation,
            direction: "incoming",
            remoteName,
            remoteUri,
            status: "ringing",
            muted: false,
        };
        updateCall(nextCall);
        setCallError(null);
        watchSession(invitation);
    }, [setCallErrorIfMounted, updateCall, watchSession]);

    const scheduleReconnect = useCallback(() => {
        if (!onlineRequestedRef.current) return;
        if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
        const delay = Math.min(30_000, 1_000 * 2 ** retryCountRef.current);
        retryCountRef.current += 1;
        setConnectionStatus("reconnecting");
        retryTimerRef.current = window.setTimeout(() => {
            void connectAndRegisterRef.current();
        }, delay);
    }, []);

    const connectAndRegister = useCallback(async () => {
        const userAgent = userAgentRef.current;
        const registerer = registererRef.current;
        if (!userAgent || !registerer || !onlineRequestedRef.current) return;

        setConnectionStatus("connecting");
        try {
            if (userAgent.state === "Started") {
                await userAgent.reconnect();
            } else {
                await userAgent.start();
            }
            await registerer.register();
        } catch (error) {
            setConnectionError(errorMessage(error));
            scheduleReconnect();
        }
    }, [scheduleReconnect]);
    useEffect(() => {
        connectAndRegisterRef.current = connectAndRegister;
    }, [connectAndRegister]);

    const connect = useCallback(async (extensionId?: string) => {
        if (connectingRef.current || connectionStatus === "connecting" || connectionStatus === "online") return;
        connectingRef.current = true;
        setConnectionError(null);
        setConnectionStatus("connecting");

        try {
            const microphone = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            microphone.getTracks().forEach((track) => track.stop());

            const sipModule = await import("sip.js");
            sipModuleRef.current = sipModule;
            const credentials = await fetchSipCredentials(extensionId);
            const uri = sipModule.UserAgent.makeURI(credentials.sipUri);
            if (!uri) throw new Error("The phone account returned an invalid SIP address.");

            const userAgent = new sipModule.UserAgent({
                uri,
                transportOptions: { server: credentials.wsUri },
                authorizationUsername: credentials.username,
                authorizationPassword: credentials.password,
                displayName: credentials.username,
                logLevel: "warn",
                delegate: {
                    onInvite: handleInvite,
                    onDisconnect: () => {
                        if (onlineRequestedRef.current) scheduleReconnect();
                    },
                },
            });
            const registerer = new sipModule.Registerer(userAgent, { expires: 180 });
            registerer.stateChange.addListener((state) => {
                if (state === "Registered") {
                    retryCountRef.current = 0;
                    setConnectionError(null);
                    setConnectionStatus("online");
                } else if (state === "Unregistered" && onlineRequestedRef.current) {
                    setConnectionStatus("connecting");
                }
            });

            userAgentRef.current = userAgent;
            registererRef.current = registerer;
            credentialsRef.current = credentials;
            onlineRequestedRef.current = true;
            setConnectionRequested(true);
            await connectAndRegister();
        } catch (error) {
            onlineRequestedRef.current = false;
            setConnectionRequested(false);
            setConnectionStatus("error");
            setConnectionError(errorMessage(error));
        } finally {
            connectingRef.current = false;
        }
    }, [connectAndRegister, connectionStatus, handleInvite, scheduleReconnect]);

    const hangUp = useCallback(async () => {
        const current = callRef.current;
        if (!current) return;
        setCallError(null);
        try {
            if (current.direction === "incoming") {
                if (current.session.state === "Initial") {
                    await current.session.reject({ statusCode: 486 });
                } else if (current.session.state === "Established") {
                    await current.session.bye();
                }
            } else {
                if (current.session.state === "Established") {
                    await current.session.bye();
                } else {
                    await current.session.cancel();
                }
            }
        } catch (error) {
            setCallErrorIfMounted(error);
        }
    }, [setCallErrorIfMounted]);

    const disconnect = useCallback(async () => {
        onlineRequestedRef.current = false;
        setConnectionRequested(false);
        if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
        await hangUp();

        let cleanupError: string | null = null;
        try {
            await registererRef.current?.unregister();
        } catch (error) {
            cleanupError = errorMessage(error);
        }
        try {
            await userAgentRef.current?.stop();
        } catch (error) {
            cleanupError = cleanupError
                ? `${cleanupError} Also failed to stop signaling: ${errorMessage(error)}`
                : errorMessage(error);
        } finally {
            userAgentRef.current = null;
            registererRef.current = null;
            sipModuleRef.current = null;
            credentialsRef.current = null;
            retryCountRef.current = 0;
            setConnectionStatus(cleanupError ? "error" : "offline");
            setConnectionError(cleanupError);
        }
    }, [hangUp]);

    const makeCall = useCallback(async (number: string) => {
        const userAgent = userAgentRef.current;
        const sipModule = sipModuleRef.current;
        const credentials = credentialsRef.current;
        if (!userAgent || !sipModule || connectionStatus !== "online") {
            setCallError("Connect the phone before placing a call.");
            return;
        }
        if (callRef.current) {
            setCallError("End the current call before placing another.");
            return;
        }

        const targetNumber = number.replace(/[^\d+]/g, "");
        if (!/^\+?\d+$/.test(targetNumber)) {
            setCallError("Enter a valid phone number.");
            return;
        }
        const accountUri = credentials ? sipModule.UserAgent.makeURI(credentials.sipUri) : undefined;
        const target = accountUri
            ? sipModule.UserAgent.makeURI(`sip:${targetNumber}@${accountUri.host}`)
            : undefined;
        if (!target) {
            setCallError("Could not build a call address from the phone account.");
            return;
        }

        setCallError(null);
        try {
            const inviter = new sipModule.Inviter(userAgent, target);
            const nextCall: ActiveCall = {
                session: inviter,
                direction: "outgoing",
                remoteName: targetNumber,
                remoteUri: target.toString(),
                status: "calling",
                muted: false,
            };
            updateCall(nextCall);
            watchSession(inviter);
            await inviter.invite({
                sessionDescriptionHandlerOptions: {
                    constraints: { audio: true, video: false },
                },
            });
        } catch (error) {
            setCallErrorIfMounted(error);
            updateCall(null);
        }
    }, [connectionStatus, setCallErrorIfMounted, updateCall, watchSession]);

    const answerCall = useCallback(async () => {
        const current = callRef.current;
        if (!current || current.direction !== "incoming") return;
        setCallError(null);
        updateCall({ ...current, status: "answering" });
        try {
            await current.session.accept({
                sessionDescriptionHandlerOptions: {
                    constraints: { audio: true, video: false },
                },
            });
            attachRemoteAudio(current.session);
        } catch (error) {
            setCallErrorIfMounted(error);
            if (callRef.current?.session === current.session) {
                updateCall({ ...current, status: "ringing" });
            }
        }
    }, [attachRemoteAudio, setCallErrorIfMounted, updateCall]);

    const declineCall = useCallback(async () => {
        const current = callRef.current;
        if (!current || current.direction !== "incoming") return;
        setCallError(null);
        try {
            await current.session.reject({ statusCode: 603 });
        } catch (error) {
            setCallErrorIfMounted(error);
        }
    }, [setCallErrorIfMounted]);

    const toggleMute = useCallback(() => {
        const current = callRef.current;
        const peerConnection = current ? getPeerConnection(current.session) : null;
        if (!current || !peerConnection) return;
        const muted = !current.muted;
        peerConnection.getSenders().forEach((sender) => {
            if (sender.track?.kind === "audio") sender.track.enabled = !muted;
        });
        updateCall({ ...current, muted });
    }, [updateCall]);

    const sendDtmf = useCallback((digit: string) => {
        const session = callRef.current?.session;
        if (!session?.sessionDescriptionHandler?.sendDtmf(digit)) {
            setCallError("This call could not send DTMF tones.");
        }
    }, []);

    const resumeAudio = useCallback(async () => {
        try {
            await audioRef.current?.play();
            setCallError(null);
        } catch (error) {
            setCallErrorIfMounted(error);
        }
    }, [setCallErrorIfMounted]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            onlineRequestedRef.current = false;
            if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
            void registererRef.current?.unregister();
            void userAgentRef.current?.stop();
        };
    }, []);

    useEffect(() => {
        if (!loggedIn && onlineRequestedRef.current) void disconnect();
    }, [disconnect, loggedIn]);

    const value: SoftphoneContextValue = {
        connectionStatus,
        connectionRequested,
        connectionError,
        call: activeCall
            ? {
                direction: activeCall.direction,
                remoteName: activeCall.remoteName,
                remoteUri: activeCall.remoteUri,
                status: activeCall.status,
                muted: activeCall.muted,
            }
            : null,
        callError,
        connect,
        disconnect,
        makeCall,
        answerCall,
        declineCall,
        hangUp,
        toggleMute,
        sendDtmf,
        resumeAudio,
    };

    return (
        <SoftphoneContext.Provider value={value}>
            {children}
            <audio ref={audioRef} autoPlay />
            <GlobalCallModal />
        </SoftphoneContext.Provider>
    );
}

function GlobalCallModal() {
    const {
        call,
        callError,
        answerCall,
        declineCall,
        hangUp,
        toggleMute,
        resumeAudio,
    } = useSoftphone();

    if (!call) return null;

    const incoming = call.direction === "incoming" && call.status === "ringing";
    const statusText = incoming
        ? "Incoming call"
        : call.status === "answering"
            ? "Answering..."
            : call.status === "calling"
                ? "Calling..."
                : "Connected";

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-950/60 p-4" role="presentation">
            <section
                aria-labelledby="global-call-title"
                aria-modal="true"
                className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl"
                role="dialog"
            >
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 text-2xl font-semibold text-blue-700">
                    {call.remoteName.slice(0, 1).toUpperCase()}
                </div>
                <p className="text-sm font-medium text-blue-700">{statusText}</p>
                <h2 id="global-call-title" className="mt-1 text-xl font-semibold text-gray-900">
                    {call.remoteName}
                </h2>
                <p className="mt-1 break-all text-sm text-gray-500">{call.remoteUri}</p>

                {callError && (
                    <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                        {callError}
                    </p>
                )}

                <div className="mt-6 flex justify-center gap-3">
                    {callError?.startsWith("Audio playback was blocked") && (
                        <button
                            onClick={() => void resumeAudio()}
                            className="rounded-full border border-gray-300 px-5 py-3 font-semibold text-gray-700 hover:bg-gray-50"
                        >
                            Enable audio
                        </button>
                    )}
                    {incoming ? (
                        <>
                            <button
                                onClick={() => void declineCall()}
                                className="rounded-full bg-red-600 px-5 py-3 font-semibold text-white hover:bg-red-700"
                            >
                                Decline
                            </button>
                            <button
                                onClick={() => void answerCall()}
                                className="rounded-full bg-green-600 px-5 py-3 font-semibold text-white hover:bg-green-700"
                            >
                                Answer
                            </button>
                        </>
                    ) : call.status === "answering" ? (
                        <p className="text-sm text-gray-500" role="status">Connecting audio...</p>
                    ) : (
                        <>
                            {call.status === "connected" && (
                                <button
                                    onClick={toggleMute}
                                    className="rounded-full border border-gray-300 px-5 py-3 font-semibold text-gray-700 hover:bg-gray-50"
                                >
                                    {call.muted ? "Unmute" : "Mute"}
                                </button>
                            )}
                            <button
                                onClick={() => void hangUp()}
                                className="rounded-full bg-red-600 px-6 py-3 font-semibold text-white hover:bg-red-700"
                            >
                                {call.status === "calling" ? "Cancel call" : "Hang up"}
                            </button>
                        </>
                    )}
                </div>
            </section>
        </div>
    );
}
