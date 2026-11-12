// Pure helpers for the softphone's call list: which call each single control acts on.
// The course grader drives ONE set of buttons (spec §4 data-testids), so with several calls up
// (call waiting, attended transfer) every control needs a well-defined target. Rules:
//   active   = the un-held call we are talking on (or the outgoing call still ringing out)
//   hangup   -> active, else the ringing incoming call (decline), else the last held call
//   hold     -> holds the active call; with no active call, resumes the last held one
//   blind    -> REFERs the active call, else the last held one
//   complete -> REFERs the held call, Replaces = the consultation call (attended transfer)
import type { SoftphoneLineInfo } from "../contexts/softphone-state";

type Line = Pick<SoftphoneLineInfo, "id" | "direction" | "status" | "held" | "busy" | "consultFor">;

const byNewest = <T extends Line>(lines: readonly T[]) => [...lines].sort((a, b) => b.id - a.id);

export function pickActive<T extends Line>(lines: readonly T[]): T | null {
    return byNewest(lines).find((l) => !l.held && l.status !== "ringing") ?? null;
}

export function pickRinging<T extends Line>(lines: readonly T[]): T | null {
    return [...lines].sort((a, b) => a.id - b.id).find((l) => l.status === "ringing") ?? null;
}

export function pickLastHeld<T extends Line>(lines: readonly T[]): T | null {
    return byNewest(lines).find((l) => l.held && l.status === "connected") ?? null;
}

export function pickHangup<T extends Line>(lines: readonly T[]): T | null {
    return pickActive(lines) ?? pickRinging(lines) ?? pickLastHeld(lines);
}

/** The line the hold toggle acts on and what it does to it. */
export function pickHold<T extends Line>(lines: readonly T[]): { line: T; hold: boolean } | null {
    const active = pickActive(lines);
    if (active) return active.status === "connected" && !active.busy ? { line: active, hold: true } : null;
    const held = pickLastHeld(lines);
    return held && !held.busy ? { line: held, hold: false } : null;
}

/** Blind transfer and the base call of an attended transfer: the active call, else the last held one. */
export function pickTransferBase<T extends Line>(lines: readonly T[]): T | null {
    const active = pickActive(lines);
    const line = active ?? pickLastHeld(lines);
    return line && line.status === "connected" && !line.busy ? line : null;
}

/** Attended transfer completion: REFER goes on `held`, with Replaces pointing at `consult`. */
export function pickTransferPair<T extends Line>(lines: readonly T[]): { held: T; consult: T } | null {
    const up = lines.filter((l) => l.status === "connected" && !l.busy);
    // The consultation call placed with softphone-transfer-attended (newest first).
    for (const consult of byNewest(up)) {
        if (consult.consultFor === null) continue;
        const held = up.find((l) => l.id === consult.consultFor);
        if (held) return { held, consult };
    }
    // Otherwise (e.g. call waiting: one held call + one active call) transfer the held call to
    // the other one.
    if (up.length === 2) {
        const held = up.find((l) => l.held);
        const consult = up.find((l) => l !== held);
        if (held && consult) return { held, consult };
    }
    return null;
}

/**
 * What the user typed in softphone-number, as the user part of the Request-URI: an extension,
 * `*98`, or any phone number format (the server normalizes). Spaces, dashes, dots and brackets
 * are dropped. Returns null if anything else is left.
 */
export function normalizeDialString(raw: string): string | null {
    const s = raw.replace(/[\s().-]/g, "");
    return /^\+?[0-9*#]+$/.test(s) ? s : null;
}

/** `#` is not allowed raw in a SIP URI user part (RFC 3261 §25.1): escape it. */
export function sipUserPart(dialString: string): string {
    return dialString.replace(/#/g, "%23");
}

/** localStorage key for the extension this user last chose in softphone-extension. */
export function storedExtensionKey(userId: string): string {
    return `pbx.softphone.extension.${userId}`;
}
