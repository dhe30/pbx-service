import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const metrics = {
  ariConnected: new Gauge({ name: 'pbx_ari_connected', help: '1 if the ARI WebSocket is up', registers: [registry] }),
  activeCalls: new Gauge({ name: 'pbx_active_calls', help: 'Inbound calls currently handled', registers: [registry] }),
  callsTotal: new Counter({
    name: 'pbx_calls_total',
    help: 'Finished inbound calls by disposition',
    labelNames: ['disposition'] as const,
    registers: [registry],
  }),
  callsOnHold: new Gauge({
    name: 'pbx_calls_on_hold',
    help: 'Connected calls the agent currently has on hold',
    registers: [registry],
  }),
  holdsTotal: new Counter({
    name: 'pbx_holds_total',
    help: 'Times an agent put a call on hold',
    registers: [registry],
  }),
  uploadBacklog: new Gauge({
    name: 'pbx_upload_backlog',
    help: 'Recordings in the spool waiting for upload',
    registers: [registry],
  }),
  uploadsTotal: new Counter({
    name: 'pbx_uploads_total',
    help: 'Recording uploads by result',
    labelNames: ['result'] as const,
    registers: [registry],
  }),
};
