-- One snapshot for the forecast tool (tools/forecast): business activity between :'from' and :'to'
-- (timestamptz), broken down by hour, plus the state of the accounts at :'to'. Prints ONE line of
-- JSON. Read-only by construction: it is only run on a replica (db-query.sh refuses a primary), in a
-- read-only transaction with a statement timeout.
--
--   psql -X -At -v from='2026-11-26 00:00+00' -v to='2026-11-26 06:00+00' -f snapshot.sql
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL TIME ZONE 'UTC';

WITH
win AS (SELECT :'from'::timestamptz AS t0, :'to'::timestamptz AS t1),
-- Size buckets by extension count (the dashboard's small / mid-size / large customers).
acct AS (
  SELECT t.id, t.created_at, coalesce(x.ext, 0) AS ext,
         CASE WHEN coalesce(x.ext, 0) <= 10 THEN 'small' WHEN x.ext <= 40 THEN 'mid' ELSE 'large' END AS size
    FROM tenants t
    LEFT JOIN (SELECT tenant_id, count(*) AS ext FROM extensions GROUP BY 1) x ON x.tenant_id = t.id, win
   WHERE t.created_at < win.t1),
-- The ONLY scan of cdrs: this window's legs, read once and reused below. Longer views (24 h,
-- active accounts over a day) are built from stored snapshots, never by rescanning here.
legs AS MATERIALIZED (
  SELECT date_trunc('hour', c.started_at) AS h, c.tenant_id,
         coalesce(c.vendor::text, CASE WHEN c.cost > 0 THEN 'tf_in' ELSE 'free' END) AS class,
         c.billable_sec, c.included_sec, c.cost, c.charge
    FROM cdrs c, win WHERE c.started_at >= win.t0 AND c.started_at < win.t1),
legs_h AS (
  SELECT h, json_object_agg(class, json_build_object(
           'legs', n, 'billed_min', round(bsec / 60.0, 1), 'included_min', round(isec / 60.0, 1),
           'cost', round(cost, 4), 'charge', round(charge, 4))) AS by_class
    FROM (SELECT h, class, count(*) n, sum(billable_sec) bsec, sum(included_sec) isec,
                 sum(cost) cost, sum(charge) charge FROM legs GROUP BY 1, 2) x
   GROUP BY h),
pay_h AS (
  SELECT h, json_object_agg(purpose, json_build_object('n', n, 'amount', amount)) AS by_purpose
    FROM (SELECT date_trunc('hour', p.created_at) h, p.purpose, count(*) n,
                 round(sum(p.amount_cents) / 100.0, 2) amount
            FROM payments p, win
           WHERE p.status = 'succeeded' AND p.amount_cents > 0
             AND p.created_at >= win.t0 AND p.created_at < win.t1
           GROUP BY 1, 2) x
   GROUP BY h),
fail_h AS (
  SELECT date_trunc('hour', p.created_at) h, count(*) n
    FROM payments p, win WHERE p.status = 'failed' AND p.created_at >= win.t0 AND p.created_at < win.t1
   GROUP BY 1),
signup_h AS (
  SELECT date_trunc('hour', t.created_at) h, count(*) n
    FROM tenants t, win WHERE t.created_at >= win.t0 AND t.created_at < win.t1 GROUP BY 1),
ext_h AS (
  SELECT date_trunc('hour', e.created_at) h, count(*) n
    FROM extensions e, win WHERE e.created_at >= win.t0 AND e.created_at < win.t1 GROUP BY 1),
num_h AS (
  SELECT date_trunc('hour', i.started_at) h,
         count(*) FILTER (WHERE pn.kind = 'local') AS local, count(*) FILTER (WHERE pn.kind = 'toll_free') AS toll_free
    FROM account_items i JOIN phone_numbers pn ON pn.id = i.phone_number_id, win
   WHERE i.kind = 'number' AND i.started_at >= win.t0 AND i.started_at < win.t1 GROUP BY 1),
hours AS (
  SELECT generate_series(date_trunc('hour', t0), t1 - interval '1 second', interval '1 hour') AS h FROM win),
hourly AS (
  SELECT json_agg(json_build_object(
           'hour', to_char(hours.h, 'YYYY-MM-DD"T"HH24:00:00"Z"'),
           'signups', coalesce(s.n, 0), 'new_extensions', coalesce(e.n, 0),
           'numbers_bought', json_build_object('local', coalesce(nb.local, 0), 'toll_free', coalesce(nb.toll_free, 0)),
           'calls', coalesce(l.by_class, '{}'::json), 'payments', coalesce(p.by_purpose, '{}'::json),
           'failed_payments', coalesce(f.n, 0)) ORDER BY hours.h) AS j
    FROM hours LEFT JOIN legs_h l USING (h) LEFT JOIN pay_h p USING (h) LEFT JOIN fail_h f USING (h)
         LEFT JOIN signup_h s USING (h) LEFT JOIN ext_h e USING (h) LEFT JOIN num_h nb USING (h)),
-- State at :'to', per size: accounts, extensions, accounts with a call in this window, and this
-- window's usage (from the single legs scan above).
win_tenants AS (SELECT DISTINCT tenant_id FROM legs),
usage_w AS (
  SELECT a.size, l.class, count(*) n, sum(l.billable_sec) / 60.0 AS min, sum(l.cost) cost, sum(l.charge) charge
    FROM legs l JOIN acct a ON a.id = l.tenant_id GROUP BY 1, 2),
usage_j AS (
  SELECT size, json_object_agg(class, json_build_object('legs', n, 'min', round(min, 1),
           'cost', round(cost, 2), 'charge', round(charge, 2))) AS j
    FROM usage_w GROUP BY size),
-- Renewing items per size (numbers by kind, add-ons): what a typical customer of each size holds.
items_by_size AS (
  SELECT a.size,
         count(*) FILTER (WHERE i.kind = 'number' AND pn.kind = 'local') AS local_numbers,
         count(*) FILTER (WHERE i.kind = 'number' AND pn.kind = 'toll_free') AS toll_free_numbers,
         count(*) FILTER (WHERE i.kind = 'recording') AS recording,
         count(*) FILTER (WHERE i.kind = 'intl_calling') AS intl_calling
    FROM account_items i JOIN acct a ON a.id = i.tenant_id
    LEFT JOIN phone_numbers pn ON pn.id = i.phone_number_id, win
   WHERE i.removed_at IS NULL AND i.started_at < win.t1 GROUP BY a.size),
sizes_j AS (
  SELECT json_object_agg(s.size, json_build_object('accounts', s.accounts,
           'active_in_window', s.active, 'extensions', s.extensions, 'new_in_window', s.new_accounts,
           'local_numbers', coalesce(it.local_numbers, 0), 'toll_free_numbers', coalesce(it.toll_free_numbers, 0),
           'recording', coalesce(it.recording, 0), 'intl_calling', coalesce(it.intl_calling, 0),
           'usage_in_window', coalesce(u.j, '{}'::json))) AS j
    FROM (SELECT a.size, count(*) accounts, count(w.tenant_id) active, sum(a.ext) extensions,
                 count(*) FILTER (WHERE a.created_at >= (SELECT t0 FROM win)) AS new_accounts
            FROM acct a LEFT JOIN win_tenants w ON w.tenant_id = a.id GROUP BY a.size) s
    LEFT JOIN usage_j u USING (size) LEFT JOIN items_by_size it USING (size)),
items AS (
  SELECT json_object_agg(k, json_build_object('active', n, 'weekly', weekly)) AS j
    FROM (SELECT i.kind || coalesce('_' || pn.kind, '') AS k, count(*) n,
                 round(sum(i.price_cents) / 100.0, 2) AS weekly
            FROM account_items i LEFT JOIN phone_numbers pn ON pn.id = i.phone_number_id, win
           WHERE i.removed_at IS NULL AND i.started_at < win.t1 GROUP BY 1) x),
renewals AS (
  SELECT json_agg(json_build_object('day', d, 'kind', k, 'items', n, 'amount', amount) ORDER BY d, k) AS j
    FROM (SELECT to_char(date_trunc('day', i.paid_through), 'YYYY-MM-DD') d,
                 i.kind || coalesce('_' || pn.kind, '') AS k, count(*) n,
                 round(sum(i.price_cents) / 100.0, 2) AS amount
            FROM account_items i LEFT JOIN phone_numbers pn ON pn.id = i.phone_number_id, win
           WHERE i.removed_at IS NULL AND i.paid_through >= win.t1 AND i.paid_through < win.t1 + interval '7 days'
           GROUP BY 1, 2) x)
SELECT json_build_object(
  'schema', 2,
  'from', to_char((SELECT t0 FROM win), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'to', to_char((SELECT t1 FROM win), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'hourly', (SELECT j FROM hourly),
  'state', json_build_object(
    'accounts', (SELECT count(*) FROM acct),
    'active_in_window', (SELECT count(*) FROM win_tenants),
    'extensions', (SELECT coalesce(sum(ext), 0) FROM acct),
    'active_extensions_in_window', (SELECT coalesce(sum(a.ext), 0) FROM acct a JOIN win_tenants w ON w.tenant_id = a.id),
    -- Accounts with a call in this window: short id -> [extensions, size]. The tool unions these over
    -- 24 h (accounts active in a day, their extensions, churn), without rescanning call records.
    'active', (SELECT coalesce(json_object_agg(left(a.id::text, 8), json_build_array(a.ext, a.size)), '{}'::json)
                 FROM acct a JOIN win_tenants w ON w.tenant_id = a.id),
    -- Accounts created in this window, and the extensions they have at its end.
    'new_accounts', (SELECT coalesce(json_object_agg(left(a.id::text, 8), json_build_array(a.ext, a.size)), '{}'::json)
                       FROM acct a, win WHERE a.created_at >= win.t0),
    'credit_held', (SELECT round(coalesce(sum(credit), 0), 2) FROM credit_balances),
    'by_size', (SELECT j FROM sizes_j),
    'renewing_items', (SELECT j FROM items),
    'renewals_next_7d', (SELECT j FROM renewals),
    'call_pricing', (SELECT row_to_json(cp) FROM call_pricing cp)));
COMMIT;
