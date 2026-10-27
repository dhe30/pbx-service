// Uploads finished recordings/voicemails from the local spool to the object store.
// Deletes the local file only after a confirmed upload; sweeps the spool dir on startup and
// every minute for orphans (retry until success).
// TODO
export {};
