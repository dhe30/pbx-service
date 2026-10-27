// Database access shared by api and ari-app (postgres.js).
// Connects through the node-local HAProxy (127.0.0.1:5432), which always points at the current
// Patroni primary. Callers must tolerate a 10-30 s failover window (retry/reconnect).
// TODO: createDb(url) with sane pool size, timeouts, and a retry helper for transient errors.
export {};
