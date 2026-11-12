import type {
  AccountStatus,
  CallPricing,
  Destination,
  ForwardDestination,
  IvrConfig,
  NumberKind,
  PrefixTable,
  RingStrategy,
  WeeklySchedule,
} from '@pbx/shared';

// In-memory snapshot of one account's call-handling config. Loaded by ConfigCache from Postgres,
// replaced on NOTIFY pbx_config / TTL. Call flows read ONLY this on the hot path (B6).

export interface NumberCfg {
  id: string;
  did: string; // E.164
  kind: NumberKind;
  destination: Destination | null;
  incomingCostPerMin: number | null;
}

export interface ExtensionCfg {
  id: string;
  number: string;
  name: string;
  sipUsername: string;
  mailboxId: string | null;
  ringTimeoutSec: number;
  forwardAlways: ForwardDestination | null;
  forwardBusy: ForwardDestination | null;
  forwardNoAnswer: ForwardDestination | null;
  externalNumbers: string[];
  callerIdNumber: string | null;
}

export interface RingGroupCfg {
  id: string;
  name: string;
  strategy: RingStrategy;
  /** sequential: per member; all: the whole group. */
  ringTimeoutSec: number;
  /** Cap on the whole group's ring time; null = none. */
  totalTimeoutSec: number | null;
  noAnswer: Destination | null;
  memberIds: string[]; // extension ids, in order
}

export interface IvrMenuCfg {
  id: string;
  greetingMediaId: string | null;
  timeoutSec: number;
  maxRetries: number;
  config: IvrConfig;
}

export interface MailboxCfg {
  id: string;
  name: string;
  greetingMediaId: string | null;
}

export interface BusinessHoursCfg {
  id: string;
  schedule: WeeklySchedule;
  open: Destination;
  closed: Destination;
}

export interface TenantConfig {
  id: string;
  name: string;
  timezone: string;
  status: AccountStatus;
  createdAt: Date;
  recordCalls: boolean;
  intlCalling: boolean;
  includedUsMinutes: number;
  numbers: Map<string, NumberCfg>; // by E.164
  /** Assigned numbers in purchase order (caller ID fallback). */
  accountNumbers: string[];
  extensions: Map<string, ExtensionCfg>;
  extByNumber: Map<string, ExtensionCfg>;
  extBySip: Map<string, ExtensionCfg>;
  ringGroups: Map<string, RingGroupCfg>;
  ivrMenus: Map<string, IvrMenuCfg>;
  mailboxes: Map<string, MailboxCfg>;
  businessHours: Map<string, BusinessHoursCfg>;
  blocked: Set<string>;
  loadedAt: number;
}

export interface Rates {
  us: PrefixTable;
  intl: PrefixTable;
  pricing: CallPricing;
}
