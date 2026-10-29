import { pino } from 'pino';

// JSON logs to stdout -> journald. Child loggers carry callId/channel so one call can be grepped.
export const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { svc: 'ari-app' } });
export type Logger = typeof log;
