import { Histogram, Registry, collectDefaultMetrics } from 'prom-client';

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
};
