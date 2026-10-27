# Kamailio schema

Do not hand-design these tables. Copy the Postgres SQL scripts shipped with the **deployed**
Kamailio version (e.g. `/usr/share/kamailio/postgres/`: `standard-create.sql`,
`auth_db-create.sql`, `usrloc-create.sql`, `dispatcher-create.sql`, `permissions-create.sql`)
into this folder and apply them in that order. [VERIFY] against the pinned Kamailio version.

Tables used: `version`, `subscriber` (written by the API), `location` (usrloc db_mode=3),
`address` (permissions: provider IPs), optionally `dispatcher`.
