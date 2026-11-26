# Forecast tool

Cash and growth forecasting for the service: what customers pay us, what calls and numbers cost us,
how long our cash lasts, and which price list wins the most new customers while keeping a safe
cash margin. **It only suggests.** Price changes still go through a branch, a PR and a deploy.

| File | What it does |
|---|---|
| `snapshot.sql` | One hour of business data (signups, calls by type with cost and charge, payments, numbers) plus the state of the accounts. Read-only transaction, 5 s statement timeout. |
| `db-query.sh` | Installed on the db nodes as the forced SSH command of the tool's key: runs `snapshot.sql` for a window of 1-6 h, **refuses the Patroni primary**, accepts nothing else. |
| `collect.py` | On mon-1: fetches every whole hour since the last stored one (one hour per query, 2 s apart) and appends it to `snapshots.jsonl`. Each call record is read once. |
| `model.py` | Bills per customer size at any price list, a signup-share model fitted to the market data, an hour-by-hour cash forecast, and the price search. Unit tests: `test_model.py`. |
| `report.py` | The command people run. Prints the report; `--summary` for a short version, `--discord` to post it. |

## Inputs that are not in the database

The bank balance, vendor balances and the market's prices and signup shares are only on the course
dashboard. `report.py` asks for them when `market.json` is missing or older than a few hours, and
lists exactly what to read off the dashboard. Formats: `market.example.json`, `settings.example.json`
(cash floor, end date, how big a price cut by another provider the plan must survive).
Those two files live only in the data directory on mon-1, not in this repository.

## Running it

Installed by `roles/forecast` (mon play in `site.yml`). On mon-1:

    sudo -u pbxforecast python3 /opt/pbx-forecast/report.py            # collect + full report
    sudo -u pbxforecast python3 /opt/pbx-forecast/report.py --summary  # our data only

The 6-hourly timer (`forecast_timer_enabled`, off by default) runs `--remind --discord`: it stores the
new hours and posts a request for the dashboard data. Forecasts run only when that data arrives.
`touch /var/lib/pbx-forecast/OFF` stops everything.

## Load on production

Per scheduled run: up to 6 queries of ~0.15 s each on a replica (measured at peak: 0.94 s for a 6 h
window), 2 s apart. mon-1 runs it at idle CPU/IO priority with `MemoryMax=200M` and `CPUQuota=50%`.
Nothing runs between scheduled or requested runs.
