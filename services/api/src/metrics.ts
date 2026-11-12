import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// Prometheus metrics, scraped from GET /metrics by mon-1 (CLAUDE.md §16).
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const metrics = {
  httpRequestDuration: new Histogram({
    name: 'pbx_api_http_request_duration_seconds',
    help: 'API request latency by route template, method and status code',
    // `route` is the template (/voicemails/:id), never the raw URL, to keep label cardinality low.
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  }),
  // Support tickets (src/routes/tickets.ts). Customers open one when something fails for them, so
  // a rising open rate is an early warning (alert on increase(...[5m]) > 0). Per process: sum over
  // the app nodes in Prometheus.
  supportTicketsOpened: new Counter({
    name: 'pbx_api_support_tickets_opened_total',
    help: 'Support tickets opened by customers',
    registers: [registry],
  }),
  supportTicketsClosed: new Counter({
    name: 'pbx_api_support_tickets_closed_total',
    help: 'Support tickets closed by customers',
    registers: [registry],
  }),
};
