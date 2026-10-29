// The carrier puts the dialed number in the Request-URI user part (assumption A3), which Asterisk
// exposes as channel.dialplan.exten. DIDs are stored as E.164 with '+', but carriers often send
// them without it, so normalize before lookup. Returns [] for anything that isn't a phone number.
export function didCandidates(exten: string): string[] {
  const digits = exten.replace(/^\+/, '');
  if (!/^[1-9][0-9]{1,14}$/.test(digits)) return [];
  return [`+${digits}`];
}
