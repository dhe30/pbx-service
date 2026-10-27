# pbx-service

Hosted, multi-tenant PBX: businesses buy a DID, configure an IVR / ring groups, and staff answer
calls in the browser over WebRTC. Call recording and voicemail included. The priority is
reliability: every component must survive the loss of any single VM.

See [CLAUDE.md](CLAUDE.md) for the full spec, architecture, and open questions.

## Layout

| Path                     | What                                                              |
|--------------------------|-------------------------------------------------------------------|
| `services/shared`        | TS package: DB access, zod schemas (IVR config), shared types      |
| `services/api`           | Fastify API (auth, numbers, staff, IVR, media, voicemail, calls)   |
| `services/ari-app`       | Asterisk ARI call-control app (IVR, ring groups, recording, VM)    |
| `services/web`           | React + Vite dashboard and SIP.js softphone                        |
| `db/migrations`          | App schema (plain SQL, dbmate)                                     |
| `db/kamailio`            | Kamailio-provided schema SQL (do not hand-edit)                    |
| `telephony/`             | Jinja templates for Kamailio, Asterisk, rtpengine                  |
| `infra/stackscripts`     | Linode first-boot script                                           |
| `infra/ansible`          | Inventory, roles, `site.yml`                                       |
| `loadtest/sipp`          | SIPp scenarios and RTP pcaps                                       |
| `dev/docker-compose.yml` | Local dev: Postgres, object store, API, web                        |

## Local development

```bash
cp .env.example .env
npm install
npm run dev:up
npm run db:migrate
```

## Status

Scaffold only. See the build phases in CLAUDE.md §17.
