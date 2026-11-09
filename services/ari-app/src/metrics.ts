import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const reg = [registry];

export const metrics = {
  ariConnected: new Gauge({ name: 'pbx_ari_connected', help: '1 if the ARI WebSocket is up', registers: reg }),
  activeCalls: new Gauge({ name: 'pbx_active_calls', help: 'Call flows currently running', registers: reg }),
  callsTotal: new Counter({
    name: 'pbx_calls_total',
    help: 'Finished CDR legs by direction and outcome',
    labelNames: ['direction', 'outcome'] as const,
    registers: reg,
  }),
  callsOnHold: new Gauge({ name: 'pbx_calls_on_hold', help: 'Connected calls currently on hold', registers: reg }),
  holdsTotal: new Counter({ name: 'pbx_holds_total', help: 'Times a party put a call on hold', registers: reg }),
  transfersTotal: new Counter({ name: 'pbx_transfers_total', help: 'Transfers by kind', labelNames: ['kind'] as const, registers: reg }),
  blockedCalls: new Counter({ name: 'pbx_blocked_calls_total', help: 'Calls rejected: blocklist, past due, no intl add-on', registers: reg }),
  vendorLegs: new Counter({ name: 'pbx_vendor_legs_total', help: 'Legs placed to PSTN vendors', labelNames: ['vendor'] as const, registers: reg }),
  vendorLegFailures: new Counter({
    name: 'pbx_vendor_leg_failures_total',
    help: 'Vendor legs that ended unanswered, by Q.850 cause (21 can be 402 = vendor out of funds)',
    labelNames: ['cause'] as const,
    registers: reg,
  }),
  configCache: new Counter({ name: 'pbx_config_cache_total', help: 'Account config lookups', labelNames: ['result'] as const, registers: reg }),
  configInvalidations: new Counter({ name: 'pbx_config_invalidations_total', help: 'NOTIFY-driven cache drops', registers: reg }),
  cdrBacklog: new Gauge({ name: 'pbx_cdr_backlog', help: 'CDR legs spooled but not yet in Postgres', registers: reg }),
  cdrsWritten: new Counter({ name: 'pbx_cdrs_written_total', help: 'CDR legs inserted', registers: reg }),
  cdrWriteErrors: new Counter({ name: 'pbx_cdr_write_errors_total', help: 'Failed CDR batch inserts', registers: reg }),
  uploadBacklog: new Gauge({ name: 'pbx_upload_backlog', help: 'Recordings in the spool waiting for upload', registers: reg }),
  uploadsTotal: new Counter({ name: 'pbx_uploads_total', help: 'Recording uploads by result', labelNames: ['result'] as const, registers: reg }),
};
