// Staff softphone panel (CLAUDE.md §12, course spec §4). Rendered by BusinessLayout next to every
// business page, so it is on the page shown after login. It is part of the page flow (no overlay),
// so it never covers other controls. All required data-testids live here and only here:
//   softphone-extension, -number, -call, -incoming, -answer, -hangup, -hold, -transfer-blind,
//   -transfer-attended, -transfer-complete, -dtmf-0..9, -dtmf-star, -dtmf-hash
// SIP behaviour behind each one: docs/telephony-contract.md §8 (SoftphoneContext implements it).
// Controls are disabled (not hidden) while they can't act, so an automated click waits for them.
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSoftphone } from "../hooks/useSoftphone";
import { useAuth } from "../hooks/useAuth";
import { apiErrorMessage, dataService, type Extension } from "../services";
import type { SoftphoneLineInfo } from "../contexts/softphone-state";
import { storedExtensionKey } from "./lines";

const KEYS = [
    { key: "1", id: "1" }, { key: "2", id: "2" }, { key: "3", id: "3" },
    { key: "4", id: "4" }, { key: "5", id: "5" }, { key: "6", id: "6" },
    { key: "7", id: "7" }, { key: "8", id: "8" }, { key: "9", id: "9" },
    { key: "*", id: "star" }, { key: "0", id: "0" }, { key: "#", id: "hash" },
];

const EXTENSIONS_REFRESH_MS = 15_000;

const statusLabels = {
    offline: "Offline",
    connecting: "Connecting…",
    online: "Registered",
    reconnecting: "Reconnecting…",
    error: "Connection failed",
} as const;

function lineLabel(line: SoftphoneLineInfo): string {
    if (line.busy) return "Updating…";
    if (line.held) return "On hold";
    switch (line.status) {
        case "ringing": return "Ringing";
        case "answering": return "Answering…";
        case "calling": return "Calling…";
        case "connected": return line.consultFor !== null ? "Consulting" : "Connected";
    }
}

function readStoredExtension(userId: string): string | null {
    try {
        return localStorage.getItem(storedExtensionKey(userId));
    } catch {
        return null;
    }
}

const button = "rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40";
const secondary = `${button} border border-gray-300 text-gray-700 hover:bg-gray-50`;

export function Softphone() {
    const { user } = useAuth();
    const location = useLocation();
    const phone = useSoftphone();
    const [extensions, setExtensions] = useState<Extension[] | null>(null);
    const [extensionsError, setExtensionsError] = useState("");
    const autoSelectedRef = useRef(false);

    // The account's extensions (any of them: spec §4 "one of the account's extensions"). Reloaded
    // on navigation and periodically so extensions created meanwhile show up.
    useEffect(() => {
        let active = true;
        const load = () => {
            if (document.visibilityState === "hidden") return;
            dataService.getExtensions()
                .then((items) => {
                    if (!active) return;
                    setExtensions(items);
                    setExtensionsError("");
                })
                .catch((cause: unknown) => {
                    if (active) setExtensionsError(apiErrorMessage(cause, "Could not load extensions."));
                });
        };
        load();
        const timer = window.setInterval(load, EXTENSIONS_REFRESH_MS);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [location.pathname]);

    // Register right away when an extension is preselected: the one this user chose last time,
    // else the one assigned to them.
    const { selectedExtensionId, selectExtension } = phone;
    useEffect(() => {
        if (autoSelectedRef.current || !extensions || !user || selectedExtensionId) return;
        autoSelectedRef.current = true;
        const stored = readStoredExtension(user.id);
        const preselected = extensions.find((e) => e.id === stored)
            ?? extensions.find((e) => e.userId === user.id);
        if (preselected) selectExtension(preselected.id);
    }, [extensions, selectExtension, selectedExtensionId, user]);

    const {
        connectionStatus, connectionError, registeredNumber, number, setNumber, lines, activeLine,
        ringingLine, callError, audioBlocked,
    } = phone;
    const online = connectionStatus === "online";
    const inCall = lines.length > 0;
    const talking = activeLine?.status === "connected";
    const selected = extensions?.find((e) => e.id === selectedExtensionId);
    const holdTarget = activeLine ? "hold" : "resume";

    function pressKey(key: string) {
        if (talking) phone.sendDtmf(key);
        else setNumber(number + key);
    }

    return (
        <section aria-label="Softphone" className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-gray-900">Softphone</h2>
                <span
                    role="status"
                    className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                        online ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600"
                    }`}
                >
                    <span className={`h-2 w-2 rounded-full ${online ? "bg-green-500" : "bg-gray-400"}`} />
                    {statusLabels[connectionStatus]}
                    {online && registeredNumber ? ` as ${registeredNumber}` : ""}
                </span>
            </div>

            {/* Extension: choosing one registers as it right away; changing it re-registers. */}
            <div>
                <label htmlFor="softphone-extension" className="block text-sm font-medium text-gray-700">
                    Extension
                </label>
                <div className="mt-1 flex gap-2">
                    <select
                        id="softphone-extension"
                        data-testid="softphone-extension"
                        value={selectedExtensionId}
                        onChange={(event) => selectExtension(event.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
                    >
                        <option value="">
                            {extensions === null ? "Loading extensions…" : "Select an extension"}
                        </option>
                        {extensions?.map((extension) => (
                            // Option text = the bare extension number, so it can be chosen by label.
                            <option key={extension.id} value={extension.id} title={extension.name}>
                                {extension.number}
                            </option>
                        ))}
                    </select>
                    {selectedExtensionId && (
                        <button type="button" onClick={() => void phone.disconnect()} className={secondary}>
                            Go offline
                        </button>
                    )}
                </div>
                {selected && (
                    <p className="mt-1 text-xs text-gray-500">
                        {selected.name}{selected.userId === user?.id ? " (assigned to you)" : ""}
                    </p>
                )}
                {extensions?.length === 0 && (
                    <p role="status" className="mt-1 text-xs text-gray-500">
                        This account has no extensions yet. An owner can add them in Team Management.
                    </p>
                )}
                {extensionsError && <p role="alert" className="mt-1 text-xs text-red-700">{extensionsError}</p>}
                {connectionError && <p role="alert" className="mt-1 text-xs text-red-700">{connectionError}</p>}
            </div>

            {/* Incoming call: only while it rings. Answering holds the call that is up (call waiting). */}
            {ringingLine && (
                <div
                    data-testid="softphone-incoming"
                    role="alert"
                    className="rounded-lg border border-blue-200 bg-blue-50 p-3"
                >
                    <p className="text-sm text-blue-900">
                        Incoming call from <span className="font-semibold">{ringingLine.remoteName}</span>
                        {talking ? " (call waiting)" : ""}
                    </p>
                    <div className="mt-2 flex gap-2">
                        <button
                            type="button"
                            data-testid="softphone-answer"
                            onClick={() => void phone.answerCall()}
                            className={`${button} bg-green-600 text-white hover:bg-green-700`}
                        >
                            Answer
                        </button>
                        <button
                            type="button"
                            onClick={() => void phone.declineCall()}
                            className={`${button} bg-red-600 text-white hover:bg-red-700`}
                        >
                            Decline
                        </button>
                    </div>
                </div>
            )}

            {/* Number: the call target, and the transfer target during a call. */}
            <div>
                <label htmlFor="softphone-number" className="block text-sm font-medium text-gray-700">
                    Number
                </label>
                <div className="mt-1 flex gap-2">
                    <input
                        id="softphone-number"
                        data-testid="softphone-number"
                        type="tel"
                        inputMode="tel"
                        autoComplete="off"
                        value={number}
                        onChange={(event) => setNumber(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !inCall) void phone.makeCall();
                        }}
                        placeholder="Extension, *98 or phone number"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base tracking-wide text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                    <button
                        type="button"
                        onClick={() => setNumber(number.slice(0, -1))}
                        disabled={!number}
                        className={secondary}
                        aria-label="Delete last digit"
                    >
                        ⌫
                    </button>
                </div>
            </div>

            {/* Keypad: types into the number, or sends DTMF (RFC 4733) during a connected call. */}
            <div className="grid grid-cols-3 gap-2" aria-label={talking ? "DTMF keypad" : "Dial pad"}>
                {KEYS.map(({ key, id }) => (
                    <button
                        key={id}
                        type="button"
                        data-testid={`softphone-dtmf-${id}`}
                        onClick={() => pressKey(key)}
                        className="h-10 rounded-lg border border-gray-200 text-lg font-semibold text-gray-900 hover:border-blue-300 hover:bg-blue-50"
                    >
                        {key}
                    </button>
                ))}
            </div>

            <button
                type="button"
                data-testid="softphone-call"
                onClick={() => void phone.makeCall()}
                disabled={!online || !number.trim()}
                className={`${button} w-full bg-green-600 py-2.5 text-white hover:bg-green-700`}
            >
                {inCall ? "New call" : "Call"}
            </button>

            {inCall && (
                <div className="space-y-3 border-t border-gray-100 pt-3">
                    <ul className="space-y-1.5" aria-label="Calls">
                        {lines.map((line) => (
                            <li
                                key={line.id}
                                className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm ${
                                    line === activeLine ? "bg-green-50 text-green-900" : "bg-gray-50 text-gray-700"
                                }`}
                            >
                                <span className="truncate font-medium">{line.remoteName}</span>
                                <span className="shrink-0 text-xs">
                                    {lineLabel(line)}{line.muted ? " · muted" : ""}
                                </span>
                            </li>
                        ))}
                    </ul>

                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            data-testid="softphone-hangup"
                            onClick={() => void phone.hangUp()}
                            disabled={!phone.canHangUp}
                            className={`${button} col-span-2 bg-red-600 text-white hover:bg-red-700`}
                        >
                            {activeLine?.status === "calling" ? "Cancel" : "Hang up"}
                        </button>
                        <button
                            type="button"
                            data-testid="softphone-hold"
                            aria-pressed={!activeLine && lines.some((l) => l.held)}
                            onClick={() => void phone.toggleHold()}
                            disabled={!phone.canHold}
                            className={secondary}
                        >
                            {holdTarget === "hold" ? "Hold" : "Resume"}
                        </button>
                        <button
                            type="button"
                            onClick={phone.toggleMute}
                            disabled={!talking}
                            className={secondary}
                        >
                            {activeLine?.muted ? "Unmute" : "Mute"}
                        </button>
                        <button
                            type="button"
                            data-testid="softphone-transfer-blind"
                            onClick={() => void phone.transferBlind()}
                            disabled={!phone.canTransferBlind}
                            className={secondary}
                            title="Transfer this call to the number above"
                        >
                            Blind transfer
                        </button>
                        <button
                            type="button"
                            data-testid="softphone-transfer-attended"
                            onClick={() => void phone.transferAttended()}
                            disabled={!phone.canTransferAttended}
                            className={secondary}
                            title="Hold this call and call the number above"
                        >
                            Consult
                        </button>
                        <button
                            type="button"
                            data-testid="softphone-transfer-complete"
                            onClick={() => void phone.transferComplete()}
                            disabled={!phone.canTransferComplete}
                            className={`${secondary} col-span-2`}
                            title="Connect the held call to the consulted party"
                        >
                            Complete transfer
                        </button>
                    </div>
                </div>
            )}

            {callError && (
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{callError}</p>
            )}
            {audioBlocked && (
                <button type="button" onClick={() => void phone.resumeAudio()} className={`${secondary} w-full`}>
                    Enable call audio
                </button>
            )}
        </section>
    );
}
