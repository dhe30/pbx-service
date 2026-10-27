// API entrypoint (Fastify). See CLAUDE.md §11 for the endpoint list.
// Stateless: auth is a signed JWT in an httpOnly cookie so any app-N replica can serve any request.
// TODO: build server, register plugins (cookie, jwt, multipart), mount routes, listen on :3000.
export {};
