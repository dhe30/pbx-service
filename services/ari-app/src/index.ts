// ARI call-control app entrypoint. One instance per Asterisk node, connects to localhost:8088,
// Stasis app name "pbx-app". See CLAUDE.md §10.
// TODO: connect with exponential-backoff reconnect, dispatch StasisStart by appArgs
//       ("inbound" vs "outbound:<callId>"), start uploader sweep, start /health + /metrics server.
export {};
