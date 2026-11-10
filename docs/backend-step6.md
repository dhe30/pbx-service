# Backend step 6: greeting upload and media

Owner: Aaron (Track 3 backend). Status: done (2026-11-09).

## What it does

Customers upload greetings for IVR menus and mailboxes. The API converts each upload with ffmpeg
to the format Asterisk plays (16-bit PCM, mono, 8 kHz WAV) and stores it in the object store. The
dashboard plays greetings, recordings and voicemail audio through the API.

| Route | Result | Errors |
|---|---|---|
| `POST /media` (audio file) | `201 media` | 400 `invalid_audio` / `invalid_request`, 413, 415, 503 |
| `GET /media?kind=greeting\|recording\|voicemail` | `200 [media]`, newest first | 400 bad `kind` |
| `GET /media/:id` | `200 media` | 404 |
| `GET /media/:id/audio` | `200` or `206` WAV bytes | 404, 416 `range_not_satisfiable`, 503 |
| `DELETE /media/:id` | `204` | 404, 409 `in_use` |

media = `{ id, kind, format, durationMs, callId, createdAt, audioUrl }`
- `kind`: `greeting` (uploaded here), `recording` or `voicemail` (written by the ARI app).
- `format`: always `"wav"`.
- `callId`: the call a recording or voicemail belongs to (`cdrs.call_id`); `null` for greetings.
- `audioUrl`: `/media/<id>/audio`, a relative URL usable directly as `<audio src>`.

All routes are owner-only. Code: `services/api/src/routes/media.ts`, `src/audio.ts`,
`src/object-store.ts`. Tests: `services/api/test/media.test.ts`.

## Uploading

Two ways to send the file:
- **Raw bytes** as the body, `Content-Type: audio/*` (e.g. `audio/mpeg`) or
  `application/octet-stream`:
  `curl -b cookies --data-binary @hello.mp3 -H 'Content-Type: audio/mpeg' .../media`
- **multipart/form-data** with the file in field `file` (an HTML form or `FormData`).

Limits: 20 MB per upload, 300 seconds of audio after conversion. Accepted formats: WAV, MP3,
Ogg (Vorbis/Opus), FLAC, M4A/MP4, WebM/MKV (what `MediaRecorder` produces), AAC, AIFF, CAF.
ffmpeg detects the format from the content; the Content-Type and file name don't matter.

Then use the returned `id` as `greetingMediaId` in `POST/PUT /ivr-menus` or `/mailboxes`.

**Media is immutable.** To change a greeting, upload a new one and point the menu or mailbox at
it, then delete the old one. The ARI app caches greeting files by media id on each pbx node, so
overwriting a file under the same id would keep playing the old audio.

## Decisions

1. **Audio is streamed through the API, not via presigned URLs** (CLAUDE.md §11 said
   `GET /media/:id/url`). The object store is on the private network (Garage on db-N), so a
   presigned URL would point at an address browsers can't reach. Streaming also keeps the
   tenant check in one place, and the URL works as a plain `<audio src>` because the browser sends
   the login cookie. `Range` requests are forwarded to the store, so seeking works. Cost: audio
   bytes pass through the app nodes. That's small (8 kHz mono = 16 KB/s), and the responses carry
   `Cache-Control: private, max-age=86400, immutable`.
2. **The object is written first, then the `media` row.** A row never points at a missing file.
   If the insert fails, the object is deleted again (best effort). On delete, the row goes first
   and the object after the commit. A leftover object is harmless and is logged.
3. **ffmpeg runs with an allowlist of input formats** (`-format_whitelist`) and only local file
   access (`-protocol_whitelist file`). Some ffmpeg inputs are playlists (HLS, concat) that open
   other files or URLs; without this, an upload could make the app node read its own files or
   fetch URLs. Each conversion gets 30 s, and at most 2 run at once per API process (CPU).
4. **A greeting that a menu or mailbox uses can't be deleted** (409 `in_use`, naming them). The
   foreign keys would set `greeting_media_id` to NULL, and callers would silently hear the
   default prompt. Same locking as the step 5 deletes (`FOR UPDATE` here, `FOR SHARE` in
   `assertGreeting`).
5. **Recordings and voicemails are listed and served by the same routes**, and are owner-only
   for now. Deleting a voicemail's audio deletes that voicemail (foreign key cascade). Step 7
   adds `/voicemails` and `/calls`, which link to `audioUrl`, and decides what staff may hear.
6. **Object store errors answer 503 `unavailable` with `Retry-After: 2`**, like a DB failover.

## Configuration

- `FFMPEG_PATH` (optional, default `ffmpeg`). ffmpeg must be installed on app nodes (and in
  the API's Docker image when that exists).
- The object store settings are unchanged (`S3_*`). Local dev: `npm run dev:up && npm run dev:s3`
  (Garage in `dev/docker-compose.yml`; the setup script creates the bucket and the dev key from
  `.env.example`).

## Tests

`npm test -w @pbx/api` runs `test/media.test.ts`:
- Without a DB: auth and owner role on every route. An anonymous upload is refused before its
  body is read.
- With ffmpeg: the conversion output (format, plain 44-byte header, duration); empty, non-audio
  and too-long input; HLS and concat playlists refused; no temp paths in error messages.
- With Postgres + ffmpeg (in-memory object store): raw and multipart upload, bad uploads store
  nothing, list/get/download with Range and 416, other tenants get 404 and can't use the greeting,
  409 while in use, delete removes the object, 503 when the store is down.

The ffmpeg tests are skipped if ffmpeg isn't installed. Checked by hand against the dev Garage
(2026-11-09): MP3 upload → 3.000 s WAV, full and ranged download, 416, delete removes the object.
