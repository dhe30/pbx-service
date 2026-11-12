import { describe, expect, it } from "vitest";
import type { SoftphoneLineInfo } from "../contexts/softphone-state";
import {
    normalizeDialString,
    pickActive,
    pickHangup,
    pickHold,
    pickRinging,
    pickTransferBase,
    pickTransferPair,
    sipUserPart,
} from "./lines";

function line(id: number, patch: Partial<SoftphoneLineInfo> = {}): SoftphoneLineInfo {
    return {
        id,
        direction: "incoming",
        remoteName: `caller${id}`,
        remoteUri: `sip:caller${id}@pbx`,
        status: "connected",
        held: false,
        busy: false,
        muted: false,
        consultFor: null,
        ...patch,
    };
}

describe("softphone call targets", () => {
    it("single connected call: every control acts on it", () => {
        const a = line(1);
        expect(pickActive([a])).toBe(a);
        expect(pickHangup([a])).toBe(a);
        expect(pickHold([a])).toEqual({ line: a, hold: true });
        expect(pickTransferBase([a])).toBe(a);
        expect(pickTransferPair([a])).toBeNull();
    });

    it("ringing call alone: hangup declines it, nothing to hold", () => {
        const r = line(1, { status: "ringing" });
        expect(pickRinging([r])).toBe(r);
        expect(pickActive([r])).toBeNull();
        expect(pickHangup([r])).toBe(r);
        expect(pickHold([r])).toBeNull();
    });

    it("call waiting: hangup ends the active call, not the ringing one", () => {
        const a = line(1);
        const r = line(2, { status: "ringing" });
        expect(pickHangup([a, r])).toBe(a);
        expect(pickRinging([a, r])).toBe(r);
    });

    it("held call alone: hold resumes it", () => {
        const a = line(1, { held: true });
        expect(pickHold([a])).toEqual({ line: a, hold: false });
        expect(pickHangup([a])).toBe(a);
        expect(pickTransferBase([a])).toBe(a);
    });

    it("attended transfer: completes held -> consult", () => {
        const a = line(1, { held: true });
        const c = line(2, { direction: "outgoing", consultFor: 1 });
        expect(pickActive([a, c])).toBe(c);
        expect(pickTransferPair([a, c])).toEqual({ held: a, consult: c });
        expect(pickHangup([a, c])).toBe(c);
    });

    it("consult still ringing out: complete not possible yet, hold disabled", () => {
        const a = line(1, { held: true });
        const c = line(2, { direction: "outgoing", status: "calling", consultFor: 1 });
        expect(pickTransferPair([a, c])).toBeNull();
        expect(pickHold([a, c])).toBeNull();
    });

    it("busy lines are not targets", () => {
        const a = line(1, { busy: true });
        expect(pickHold([a])).toBeNull();
        expect(pickTransferBase([a])).toBeNull();
    });
});

describe("dial strings", () => {
    it("keeps digits, *, # and a leading +", () => {
        expect(normalizeDialString("*98")).toBe("*98");
        expect(normalizeDialString("(631) 555-0100")).toBe("6315550100");
        expect(normalizeDialString("+44 20 7946 0958")).toBe("+442079460958");
        expect(normalizeDialString("011 44 20")).toBe("0114420");
        expect(normalizeDialString("12#")).toBe("12#");
    });

    it("rejects anything else", () => {
        expect(normalizeDialString("")).toBeNull();
        expect(normalizeDialString("abc")).toBeNull();
        expect(normalizeDialString("1+2")).toBeNull();
    });

    it("escapes # in the URI user part", () => {
        expect(sipUserPart("12#")).toBe("12%23");
        expect(sipUserPart("*98")).toBe("*98");
    });
});
