# Kamailio schema

Copied unmodified from the Kamailio source tree, branch `6.0`
(`utils/kamctl/postgres/`). Refresh these files whenever `kamailio_version` changes in
`infra/ansible/group_vars/all/main.yml`, because the `version` rows must match what the modules expect.

| File                  | Tables                         | Used by                         |
|-----------------------|--------------------------------|---------------------------------|
| `standard-create.sql` | `version`                      | all DB-backed modules           |
| `auth_db-create.sql`  | `subscriber`                   | auth_db (REGISTER auth); written by the API |
| `usrloc-create.sql`   | `location`, `location_attrs`   | usrloc `db_mode=3` (shared by both edges) |

They are applied (in that order) by the `db_schema` Ansible role, as the `kamailio` DB role, into
the `kamailio` schema of the `pbx` database. The `kamailio` role's `search_path` is set to
`kamailio`, so Kamailio sees unqualified table names. The app (`pbx_app` role) gets DML rights on
these tables so the API can create/delete `subscriber` rows.
