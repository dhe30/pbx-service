// zod schema for ivr_menus.config (see CLAUDE.md §6).
// TODO: IvrAction (ring_group | voicemail | user), IvrConfig { options: Record<digit, IvrAction>,
//       on_timeout: IvrAction }, and a parse helper used by both api (write) and ari-app (read).
export {};
