import api from "./api";

export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

export interface CallLeg {
    id: string;
    callId: string;
    parentId: string | null;
    direction: "incoming" | "outgoing" | "internal";
    fromNumber: string | null;
    toNumber: string | null;
    did: string | null;
    fromExtension: string | null;
    toExtension: string | null;
    startedAt: string;
    answeredAt: string | null;
    endedAt: string | null;
    billableSec: number;
    outcome: "answered" | "busy" | "no_answer" | "failed" | "blocked";
    voicemail: boolean;
    vendor: "us" | "intl" | null;
    charge: number;
    includedSec: number;
    recordingUrl: string | null;
}

export interface VoicemailMessage {
    id: string;
    mailboxId: string;
    mailboxName: string;
    callerNumber: string | null;
    callId: string;
    heard: boolean;
    durationMs: number | null;
    createdAt: string;
    audioUrl: string;
}

export interface Extension {
    id: string;
    number: string;
    name: string;
    sipUsername: string;
    mailboxId: string | null;
    ringTimeoutSec: number;
    forwardAlways: unknown;
    forwardBusy: unknown;
    forwardNoAnswer: unknown;
    externalNumbers: string[];
    callerIdNumber: string | null;
    userId: string | null;
}

export interface StaffMember {
    id: string;
    email: string;
    role: "staff";
    createdAt: string;
}

export interface PhoneNumber {
    id: string;
    did: string;
    status: "assigned" | "released";
    kind: "local" | "toll_free";
    destination: Destination | null;
    paidUntil: string | null;
    purchasedAt: string | null;
}

export interface Country {
    iso: string;
    name: string;
    prefix: string;
}

export type Destination =
    | { type: "extension" | "ring_group" | "ivr_menu" | "voicemail" | "business_hours"; id: string }
    | { type: "external"; number: string }
    | { type: "hangup" };

export interface RingGroup {
    id: string;
    name: string;
    strategy: "all" | "sequential";
    ringTimeoutSec: number;
    noAnswerDestination: Destination | null;
    memberIds: string[];
}

export interface IvrMenu {
    id: string;
    name: string;
    greetingMediaId: string | null;
    timeoutSec: number;
    maxRetries: number;
    config: IvrConfig;
}

export interface IvrConfig {
    options: Record<string, Destination>;
    timeout?: Destination;
    invalid?: Destination;
    repeat_digit?: string;
}

export interface BusinessHours {
    id: string;
    name: string;
    schedule: { intervals: Array<{ day: number; start: string; end: string }> };
    openDestination: Destination;
    closedDestination: Destination;
    openNow: boolean;
}

export interface Mailbox {
    id: string;
    name: string;
    greetingMediaId: string | null;
    ownerUserId: string | null;
}

export interface BillingState {
    card: { brand: string | null; last4: string | null } | null;
    planPaidThrough: string | null;
    currentPeriod: { start: string; end: string };
    extensions: { used: number; allowed: number };
}

export interface BillingPrices {
    currency: "usd";
    billingPeriodDays: 7;
    plan: {
        name: string;
        priceCents: number;
        includedExtensions: number;
        includedUsMinutes: number;
    };
    extensionCents: number;
    localNumberCents: number;
    tollFreeNumberCents: number;
    intlCallingCents: number;
    recordingCents: number;
    perMinute: {
        usPerMin: number;
        tollFreeInPerMin: number;
        intlMultiplier: number;
        intlMinPerMin: number;
    };
}

export interface BillingItem {
    id: string;
    kind: "plan" | "extension" | "number" | "intl_calling" | "recording";
    priceCents: number;
    startedAt: string;
    paidThrough: string;
    removedAt: string | null;
    renews: boolean;
    phoneNumberId: string | null;
    did: string | null;
}

export interface Invoice {
    id: string;
    periodStart: string;
    periodEnd: string;
    usageFrom: string;
    usageTo: string;
    recurringCents: number;
    usageCents: number;
    totalCents: number;
    includedMinutesUsed: number;
    status: string;
    pastDue: boolean;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: string | null;
    paidAt: string | null;
    createdAt: string;
}

export interface Settings {
    recordCalls: boolean;
    intlCalling: boolean;
    includedUsMinutes: number;
    includedExtensions: number;
    extraExtensions: number;
}

export interface CallsQuery {
    from?: string;
    to?: string;
    direction?: CallLeg["direction"];
    outcome?: CallLeg["outcome"];
    extension?: string;
    number?: string;
    limit?: number;
    cursor?: string;
}

export interface VoicemailsQuery {
    mailboxId?: string;
    heard?: boolean;
    limit?: number;
    cursor?: string;
}

export const dataService = {
    async getCalls(params: CallsQuery = {}) {
        const { data } = await api.get<Page<CallLeg>>("/calls", { params });
        return data;
    },
    async getVoicemails(params: VoicemailsQuery = {}) {
        const { data } = await api.get<Page<VoicemailMessage>>("/voicemails", { params });
        return data;
    },
    async updateVoicemail(id: string, heard: boolean) {
        const { data } = await api.patch<VoicemailMessage>(`/voicemails/${id}`, { heard });
        return data;
    },
    deleteVoicemail(id: string) {
        return api.delete<void>(`/voicemails/${id}`);
    },
    async getExtensions() {
        const { data } = await api.get<Extension[]>("/extensions");
        return data;
    },
    async getStaff() {
        const { data } = await api.get<StaffMember[]>("/staff");
        return data;
    },
    async createStaff(email: string, password?: string) {
        const { data } = await api.post<StaffMember>("/staff", {
            email,
            ...(password ? { password } : {}),
        });
        return data;
    },
    async getNumbers() {
        const { data } = await api.get<PhoneNumber[]>("/numbers");
        return data;
    },
    async getCountries() {
        const { data } = await api.get<Country[]>("/numbers/countries");
        return data;
    },
    async getBilling() {
        const { data } = await api.get<BillingState>("/billing");
        return data;
    },
    async getBillingPrices() {
        const { data } = await api.get<BillingPrices>("/billing/prices");
        return data;
    },
    async getBillingItems() {
        const { data } = await api.get<BillingItem[]>("/billing/items");
        return data;
    },
    async getSettings() {
        const { data } = await api.get<Settings>("/settings");
        return data;
    },
    async getInvoices() {
        const { data } = await api.get<Invoice[]>("/invoices");
        return data;
    },
    async getRingGroups() {
        const { data } = await api.get<RingGroup[]>("/ring-groups");
        return data;
    },
    async getIvrMenus() {
        const { data } = await api.get<IvrMenu[]>("/ivr-menus");
        return data;
    },
    async getBusinessHours() {
        const { data } = await api.get<BusinessHours[]>("/business-hours");
        return data;
    },
    async getMailboxes() {
        const { data } = await api.get<Mailbox[]>("/mailboxes");
        return data;
    },
};

export function apiAssetUrl(path: string): string {
    return path.startsWith("/api/") ? path : `/api${path.startsWith("/") ? path : `/${path}`}`;
}
