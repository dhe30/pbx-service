import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import type { UserRole } from '@pbx/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { HttpError } from './errors.js';

// Authentication (CLAUDE.md §11): signed JWTs in httpOnly cookies, stateless across replicas.
//
// Two tokens, both signed with JWT_SECRET (identical on every app-N):
//  - access  (cookie pbx_access, path /, short-lived): sent with every request; proves who you are.
//  - refresh (cookie pbx_refresh, path /auth, long-lived): only sent to /auth/*; trades itself for
//    a new access + refresh pair via POST /auth/refresh. The refresh route re-reads the user from
//    the DB, so a deleted user loses access within one access-token lifetime.
// No server-side sessions: logout clears the cookies, but a copied token stays valid until it
// expires. Acceptable for course scope because access tokens are short-lived.
//
// CSRF: cookies are SameSite=Lax (not sent on cross-site POSTs), and the API only accepts JSON
// bodies (Fastify answers 415 to HTML-form content types).

export const ACCESS_COOKIE = 'pbx_access';
export const REFRESH_COOKIE = 'pbx_refresh';
const REFRESH_PATH = '/auth';

/** Who is making the request. Set by `authenticate`; every tenant-scoped query uses tenantId. */
export interface AuthUser {
  userId: string;
  tenantId: string | null;
  role: UserRole;
}

type TokenType = 'access' | 'refresh';
interface TokenPayload {
  sub: string;
  tid: string | null;
  role: UserRole;
  typ: TokenType;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Null until `authenticate` ran successfully. */
    auth: AuthUser | null;
  }
}

type AuthConfig = Pick<Config, 'JWT_SECRET' | 'ACCESS_TOKEN_TTL_SEC' | 'REFRESH_TOKEN_TTL_SEC' | 'COOKIE_SECURE'>;

/** Registers cookie + JWT support on the root instance. Call once from buildApp. */
export async function registerAuth(app: FastifyInstance, cfg: AuthConfig): Promise<void> {
  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: cfg.JWT_SECRET,
    sign: { algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] }, // never accept alg "none" or another algorithm
  });
  app.decorateRequest('auth', null);
  app.decorate('authCfg', cfg);
}

declare module 'fastify' {
  interface FastifyInstance {
    authCfg: AuthConfig;
  }
}

/** Sets fresh access + refresh cookies for `user` (after signup, login, refresh). */
export function setAuthCookies(reply: FastifyReply, user: AuthUser): void {
  const cfg = reply.server.authCfg;
  const base = { httpOnly: true, secure: cfg.COOKIE_SECURE, sameSite: 'lax' as const };
  reply.setCookie(ACCESS_COOKIE, sign(reply.server, user, 'access', cfg.ACCESS_TOKEN_TTL_SEC), {
    ...base,
    path: '/',
    maxAge: cfg.ACCESS_TOKEN_TTL_SEC,
  });
  reply.setCookie(REFRESH_COOKIE, sign(reply.server, user, 'refresh', cfg.REFRESH_TOKEN_TTL_SEC), {
    ...base,
    path: REFRESH_PATH,
    maxAge: cfg.REFRESH_TOKEN_TTL_SEC,
  });
}

export function clearAuthCookies(reply: FastifyReply): void {
  const cfg = reply.server.authCfg;
  const base = { httpOnly: true, secure: cfg.COOKIE_SECURE, sameSite: 'lax' as const };
  // Path must match the one used when setting, or the browser keeps the cookie.
  reply.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
}

/**
 * preHandler for protected routes: `app.get('/x', { preHandler: authenticate }, handler)`.
 * Missing, expired, tampered or wrong-type token -> 401 { error: "unauthorized" }.
 */
export async function authenticate(req: FastifyRequest): Promise<void> {
  const user = verifyToken(req.server, req.cookies[ACCESS_COOKIE], 'access');
  if (!user) throw new HttpError(401, 'unauthorized', 'Not logged in or session expired');
  req.auth = user;
}

/** preHandler that must run after `authenticate`: `{ preHandler: [authenticate, requireRole('owner')] }`. */
export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.auth) throw new HttpError(401, 'unauthorized', 'Not logged in or session expired');
    if (!roles.includes(req.auth.role)) throw new HttpError(403, 'forbidden', 'Not allowed for your role');
  };
}

/** Returns the user in a valid refresh cookie, or null. Used only by POST /auth/refresh. */
export function readRefreshToken(req: FastifyRequest): AuthUser | null {
  return verifyToken(req.server, req.cookies[REFRESH_COOKIE], 'refresh');
}

function sign(app: FastifyInstance, user: AuthUser, typ: TokenType, ttlSec: number): string {
  const payload: TokenPayload = { sub: user.userId, tid: user.tenantId, role: user.role, typ };
  return app.jwt.sign(payload, { expiresIn: ttlSec });
}

function verifyToken(app: FastifyInstance, token: string | undefined, typ: TokenType): AuthUser | null {
  if (!token) return null;
  try {
    const p = app.jwt.verify<TokenPayload>(token);
    // A refresh token must never work as an access token (and vice versa).
    const validRoleAndTenant =
      p.role === 'unassigned'
        ? p.tid === null
        : (p.role === 'owner' || p.role === 'staff') && typeof p.tid === 'string' && p.tid.length > 0;
    if (p.typ !== typ || !p.sub || !validRoleAndTenant) return null;
    return { userId: p.sub, tenantId: p.tid, role: p.role };
  } catch {
    return null; // bad signature, expired, malformed
  }
}
