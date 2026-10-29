# Split deployment: shared contracts

The names, addresses and ports that the parallel work tracks agree on, so each track can be
built and tested on its own and merged without breaking the others. Spec background:
CLAUDE.md §4 (architecture), §13 (data HA), §14 (ports), §15 (deployment).

**Rule:** anything in this file is an interface. Changing it needs a PR that every track owner
reviews. Adding new names (a new variable, vault key or port) only needs the owning track,
plus a line here in the same PR.

## 1. Work tracks

In one line each:
- **T1 Data tier:** make the database and file storage survive losing any one of db-1..3 (Postgres
  replicated and failed over by Patroni + etcd, 3-copy Garage). Every other VM reaches them
  through a local proxy on `127.0.0.1`, so clients never notice which node is primary.
- **T2 Telephony split:** take the working one-VM phone system and run it on 2 edge + 2 pbx VMs
  so either of each can die mid-test: Kamailio spreads calls over both Asterisk nodes and either
  edge can reach any browser.
- **T3 API + web:** build the customer-facing product: signup, buying numbers, IVR/ring group/staff
  setup, voicemail and call history pages, and the browser softphone. Runs locally with
  docker-compose against the existing database schema.
- **T4 Monitoring + backups:** make failures visible and recoverable: Prometheus/Grafana/alerts
  on mon-1 for every node and service, plus nightly Postgres backups with a tested restore.
  Starts now against the all-in-one VM (node_exporter, rtpengine, HAProxy, ARI app, Asterisk
  metrics, SIPp synthetic call). Scrape targets come from inventory groups, so new nodes appear
  by themselves. Patroni/etcd/API alerts are written ahead and verified as T1/T3 land. Backups
  wait for T1's Postgres layout. Decide O1 (metrics bound to 127.0.0.1) first.

| Track | Scope | Roles / dirs it owns | Depends on |
|---|---|---|---|
| **T1 Data tier** | Patroni + etcd + Postgres on db-1..3, local DB proxy on clients, 3-node Garage + local S3 endpoint, `db_schema` against the primary | `etcd`, `postgres_patroni`, `db_local_proxy`, `objectstore`, `db_schema` | §3, §5, §6 |
| **T2 Telephony split** | 2 edge + 2 pbx: dispatcher over both pbx, Path relay between edges, shared rtpengine set, HAProxy WS backends | `kamailio`, `rtpengine`, `edge_haproxy`, `asterisk`, `ari_app`, `telephony/` | §5 (uses the temporary values in §8 until T1 lands) |
| **T3 API + web** | Phase 2: Fastify API, React dashboard + softphone | `services/api`, `services/web`, `services/shared`, `db/migrations`, role `api` | §5 (schema), §6 |
| **T4 Monitoring + backups** | Prometheus/Grafana/Alertmanager on mon-1, exporters, pgBackRest/wal-g | `monitoring`, `backups` | §4 ports, §7 health/metrics |
| (everyone) | Baseline, host firewall | `common` | coordinate in PRs |

Merge order isn't forced; §8 says what to do while a dependency hasn't landed. Start every
track from `main` **after** the phase-1 PR (`phase1/telephony`) is merged.

## 2. Inventory

Groups (fixed): `edge`, `pbx`, `app`, `db`, `mon`, and `db_clients` = children `edge`, `pbx`,
`app`. Host names: `edge-1`, `edge-2`, `pbx-1`, `pbx-2`, `app-1`, `app-2`, `db-1`..`db-3`,
`mon-1`. Example with every variable: `infra/ansible/inventory/staging.ini`.

Per-host variables:

| Variable | Hosts | Meaning |
|---|---|---|
| `ansible_host` | all | address Ansible SSHes to |
| `private_ip` | all (**required**) | the VM's private address. Every internal service binds to it |
| `public_ip` | edge (**required**) | public address: SIP, HTTPS/WSS, rtpengine media |
| `public_bind_ip` | edge (optional) | local address the public IP is NATed to, if it isn't on the interface |
| `asterisk_sip_port` | pbx (optional) | default 5060. Only the all-in-one VM uses 5080 |

Group order matters: `edge_trunk_names` maps `groups['edge'][0]` -> `edge-a`, `[1]` -> `edge-b`.
Don't reorder edge hosts on a live system.

## 3. Shared variables (`infra/ansible/group_vars/all/main.yml`)

Stable names. Values may change only through the owning track.

| Variable | Value / meaning | Owner | Read by |
|---|---|---|---|
| `db_host` | `127.0.0.1`: every client talks to its local DB proxy | T1 | all DB clients |
| `db_name` | `pbx` | T1 | all |
| `db_app_user` / `db_kamailio_user` | `pbx_app` / `kamailio` | T1 | ari_app, api / kamailio |
| `app_db_url`, `kamailio_db_url` | built from the above + vault passwords, port 5432 | T1 | ari_app, api / kamailio |
| `s3_endpoint` | phase 1: `http://<db-1 private_ip>:3900`. **T1 changes it to `http://127.0.0.1:3900`** (local S3 proxy) | T1 | ari_app, api |
| `s3_bucket`, `s3_region` | `pbx-media`, `garage` | T1 | ari_app, api |
| `garage_replication_factor` | number of db hosts, max 3 (1 all-in-one, 3 split); must be right before data is stored | T1 | objectstore |
| `sip_domain` | `pbx.local` (until there's a DNS name) | T2 | kamailio, api (SIP creds), web |
| `carrier_cidrs` | provider source IPs | T2 | kamailio |
| `kamailio_ws_port` | 8080 | T2 | kamailio, edge_haproxy |
| `edge_trunk_names`, `rtpengine_ips`, `edge_peer_ips` | derived from `groups['edge']` | T2 | asterisk, ari_app, kamailio |
| `ari_user`, `hold_max_sec` | `pbxapp`, 1800 | T2 | asterisk, ari_app |
| `*_version` pins | see file | owner of the component | roles |

## 4. Ports

Bind address and who may connect. "cluster" = any `private_ip` in the inventory (nftables set
in the `common` role). Per-port allowlists are a T4/hardening follow-up; today the host firewall
lets the whole cluster reach every private port.

| Port | Service | Host | Binds | Clients |
|---|---|---|---|---|
| 22/tcp | SSH | all | all | admins |
| 5060/udp | Kamailio (carrier, SIP phones) | edge | public_ip | internet (carrier, phones) |
| 5060/udp | Kamailio (internal) | edge | private_ip | pbx, peer edge |
| 443/tcp | HAProxy HTTPS + WSS | edge | public_ip | browsers |
| 8080/tcp | Kamailio WebSocket | edge | private_ip | HAProxy on any edge |
| 30000-40000/udp | rtpengine media (external) | edge | public_ip | internet |
| 2223/udp | rtpengine ng control | edge | private_ip | Kamailio on any edge |
| 2225/tcp | rtpengine metrics | edge | private_ip | Prometheus |
| 8404/tcp | HAProxy stats + `/metrics` | edge | private_ip | Prometheus |
| 5060/udp | Asterisk PJSIP | pbx | private_ip | Kamailio (any edge) |
| 10000-20000/udp | Asterisk RTP | pbx | private_ip | rtpengine (internal side) |
| 8088/tcp | Asterisk ARI + `/metrics` | pbx | 127.0.0.1 | local ARI app only |
| 9101/tcp | ARI app `/health`, `/metrics` | pbx | 127.0.0.1 | local (see open item O1) |
| 3000/tcp | API | app | private_ip | HAProxy on edges |
| 5432/tcp | Postgres | db | private_ip | local DB proxies (+ replicas) |
| 8008/tcp | Patroni REST (`/primary`, `/replica`, `/health`) | db | private_ip | local DB proxies, Prometheus |
| 2379, 2380/tcp | etcd client / peer | db | private_ip | Patroni / other etcd members |
| 3900/tcp | Garage S3 API | db | private_ip | local S3 proxies |
| 3901/tcp | Garage RPC | db | private_ip | other Garage nodes |
| 3903/tcp | Garage admin + metrics | db | 127.0.0.1 | local (see O1) |
| 5432/tcp | **local DB proxy** | db_clients | 127.0.0.1 | local services |
| 3900/tcp | **local S3 proxy** | db_clients | 127.0.0.1 | local services |
| 9100/tcp | node_exporter | all | private_ip | Prometheus |

## 5. Database contract

- **Address:** `127.0.0.1:5432` on every client. The local proxy forwards only to the node whose
  `GET http://<db private_ip>:8008/primary` returns 200. Read-only replica routing is not
  needed.
- **Database / schemas:** database `pbx`. App tables in `public` (owner `pbx_app`). Kamailio
  tables in schema `kamailio` (owner `kamailio`, role search_path = `kamailio`), from the SQL
  in `db/kamailio/` for Kamailio 6.0. `pbx_app` can read and write `kamailio.*` (the API writes
  `subscriber`).
- **Roles/schemas** are created by `roles/db_schema/templates/bootstrap.sql.j2` (idempotent).
  T1 must run it, the Kamailio SQL, dbmate migrations (`db/migrations`) and the test seed
  **against the current primary only**, once per deploy.
- **Migrations:** plain SQL, dbmate, owned by T3. Every migration must be backward compatible
  with the running code (add columns/tables first, remove later), because pbx/app nodes are
  updated one at a time.
- **Failover behaviour clients must survive:** connections drop once; writes fail for up to
  ~30 s; then the same address works again. Clients reconnect and retry, never exit or hang.
  Kamailio usrloc (`db_mode=3`) must keep running. T1 verifies this; T2/T3 keep their DB code
  retry-safe.

## 6. Object store contract

- **Endpoint:** `s3_endpoint` (S3 API, path-style, region `garage`), bucket `pbx-media`, one
  access key from vault (`vault_s3_access_key` / `vault_s3_secret_key`), imported with the same
  value on every node.
- **Object keys:** `tenants/<tenant_id>/<kind>/<media_id>.wav`, with kind = `greeting` |
  `recording` | `voicemail` (`mediaObjectKey()` in `services/shared/src/types.ts`). Writers
  never overwrite another media id. Uploads are idempotent per media id.
- **Durability:** with 3 nodes and `replication_factor = 3`, losing any one node keeps reads
  and writes working.
- **Audio format:** 8 kHz mono 16-bit WAV (what Asterisk records and plays). The API converts
  uploads to it.

## 7. Health and metrics (for HAProxy, Ansible waits and Prometheus)

| Service | Health | Metrics |
|---|---|---|
| ARI app | `GET 127.0.0.1:9101/health` -> 200 when ARI and DB are OK | `127.0.0.1:9101/metrics` |
| API | `GET :3000/health` (liveness), `/ready` (DB + S3) | `:3000/metrics` |
| Patroni | `GET :8008/health`, `/primary`, `/replica` | `:8008/metrics` |
| Kamailio | SIP OPTIONS -> 200 | (T4 decides: xhttp_prom or exporter) |
| rtpengine | ng `ping` | `private_ip:2225/metrics` |
| HAProxy | — | `private_ip:8404/metrics` |
| Garage | `garage status` | `127.0.0.1:3903/metrics` |
| Asterisk | `pjsip show endpoints` | `127.0.0.1:8088/metrics` (res_prometheus) |

## 8. While a dependency hasn't landed

Ansible precedence trap: variables under `[group:vars]` in an inventory file **lose** to
`group_vars/all/main.yml`. For a temporary override use `-e name=value` on the command line, or
an inline host var (`host-1 ... name=value`), never `[group:vars]`.

| Situation | Do this (on your command line / test inventory, not in `group_vars`) |
|---|---|
| T2/T3 need a DB but T1 isn't merged | Install Postgres on db-1 with role `postgres_standalone` + `db_schema`, and run the playbook with `-e db_host=<db-1 private_ip>`. Drop the flag when T1 lands. |
| Need S3 but T1's local S3 proxy isn't merged | Keep `s3_endpoint=http://<db-1 private_ip>:3900` (today's value) with single-node Garage on db-1. |
| T1 needs a client to test against | One extra VM in `db_clients` running only `common` + `db_local_proxy`; check `psql -h 127.0.0.1 -U pbx_app pbx` survives killing the primary. |
| T4 needs targets | Scrape the all-in-one VM (`inventory/allinone.ini` / `local-vm.ini`) first. |

## 9. Open items (decide in the owning track, then update this file)

- **O1 (T4):** ARI app metrics (9101), Asterisk metrics (8088) and Garage metrics (3903) bind to
  127.0.0.1, so Prometheus on mon-1 can't reach them. Options: bind them to `private_ip`, or
  scrape through a local exporter/agent.
- **O2 (T1):** where the local S3 proxy runs (same HAProxy as the DB proxy is simplest).
- **O3 (T1/T4):** backup target for WAL archiving (mon-1 volume?) and restore drill.
- **O4 (T2):** HAProxy on each edge sends `/api` to app-1/app-2 (`backend api` already templates
  `groups['app']`); confirm the API health path with T3.
