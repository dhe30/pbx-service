"""Unit tests for the forecast model (stdlib unittest):  python3 -m unittest tools/forecast/test_model.py"""
import datetime as dt
import json
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
UTC = dt.timezone.utc
T0 = dt.datetime(2026, 12, 1, tzinfo=UTC)


def snapshot(hour, signups=1, new_ext=10, us=(1000, 6.0, 6.5), tf=(100, 2.5, 1.2), topups=(10, 60.0),
             active=None, new_accounts=None, invoice=(0, 0.0)):
    """One synthetic hourly snapshot (schema 2). us/tf = (minutes, cost, charge) for the hour, split
    over sizes small/mid/large as 10/30/60 %; active: {id: [ext, size]} (default: a fixed set)."""
    t0 = T0 + dt.timedelta(hours=hour)
    calls = {"us": {"legs": 100, "billed_min": us[0], "included_min": 0, "cost": us[1], "charge": us[2]},
             "tf_in": {"legs": 10, "billed_min": tf[0], "included_min": 0, "cost": tf[1], "charge": tf[2]}}
    if active is None:
        active = {f"s{i:07d}": [5, "small"] for i in range(6)}
        active.update({f"m{i:07d}": [25, "mid"] for i in range(3)})
        active.update({"l0000000": [200, "large"]})
    by_size = {}
    for s, f in (("small", 0.1), ("mid", 0.3), ("large", 0.6)):
        n = sum(1 for v in active.values() if v[1] == s)
        by_size[s] = {"accounts": n, "active_in_window": n, "extensions": sum(v[0] for v in active.values() if v[1] == s),
                      "new_in_window": 0, "local_numbers": n, "toll_free_numbers": 0, "recording": 0, "intl_calling": 0,
                      "usage_in_window": {"us": {"legs": 1, "min": us[0] * f, "cost": us[1] * f, "charge": us[2] * f},
                                          "tf_in": {"legs": 1, "min": tf[0] * f, "cost": tf[1] * f, "charge": tf[2] * f}}}
    pay = {"topup": {"n": topups[0], "amount": topups[1]}}
    if invoice[0]:
        pay["invoice"] = {"n": invoice[0], "amount": invoice[1]}
    return {
        "schema": 2, "from": t0.strftime("%Y-%m-%dT%H:%M:%SZ"), "to": (t0 + dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "hourly": [{"hour": t0.strftime("%Y-%m-%dT%H:%M:%SZ"), "signups": signups, "new_extensions": new_ext,
                    "numbers_bought": {"local": signups, "toll_free": 0}, "calls": calls,
                    "payments": pay, "failed_payments": 0}],
        "state": {"accounts": len(active), "extensions": sum(v[0] for v in active.values()), "credit_held": 500.0,
                  "by_size": by_size, "active": active, "new_accounts": new_accounts or {},
                  "renewing_items": {"plan": {"active": 10, "weekly": 10.0}, "number_local": {"active": 10, "weekly": 10.0}}},
    }


def market():
    with open(os.path.join(HERE, "market.example.json")) as f:
        m = json.load(f)
    b = m["bank"]
    m["cash_total"] = b["bank"] + b["did"] + b["us_vendor"] + b["intl_vendor"] + b.get("cloud", 0) - b["loan_owed"]
    return m


def settings():
    with open(os.path.join(HERE, "settings.example.json")) as f:
        s = json.load(f)
    s["end"] = dt.datetime(2026, 12, 4, tzinfo=UTC)
    s["floor_final_from"] = dt.datetime(2026, 12, 3, tzinfo=UTC)
    return s


def context(snaps, m=None, s=None, trend=(0.0, 2.0), churn=None):
    m = m or market()
    s = s or settings()
    econ = model.economics(model.last_hours(snaps, 24))
    fits = model.fit_dashboard_profiles(m, model.shape_from_snapshots(snaps))
    profiles = {k: v[0] for k, v in fits.items()}
    return model.Context(m, s, econ, profiles, 2.0, 0.5, T0 + dt.timedelta(days=2), s["end"], [m], trend, churn)


class Base(unittest.TestCase):
    def test_active_accounts_are_the_union_over_the_day(self):
        snaps = []
        for h in range(24):            # a different small account is active each hour
            snaps.append(snapshot(h, active={f"x{h:07d}": [2, "small"], "l0000000": [200, "large"]}))
        e = model.economics(snaps)
        self.assertTrue(e["exact"])
        self.assertEqual(e["active_accounts"]["small"], 24)
        self.assertEqual(e["active_ext"]["small"], 48)
        self.assertEqual(e["active_ext"]["large"], 200)
        # per active extension: 24 h of small usage (10 % of 8.5/h cost) over 48 small extensions
        small_cost = sum(e["per_ext"]["small"][c]["cost"] for c in model.CLASSES)
        self.assertAlmostEqual(small_cost, 24 * 8.5 * 0.1 / 48)

    def test_new_accounts_and_upgrades(self):
        snaps = [snapshot(h, new_ext=10) for h in range(24)]
        snaps[5]["state"]["new_accounts"] = {"n0000001": [3, "small"]}
        snaps[20]["state"]["active"]["n0000001"] = [4, "small"]     # it grew to 4 by the end
        e = model.economics(snaps)
        self.assertEqual(e["ext_per_new"]["small"], 4)
        self.assertAlmostEqual(e["new_mix"]["small"], 1.0)
        self.assertAlmostEqual(e["upgrades_per_day"], 240 - 4)

    def test_churn_counts_accounts_gone_since_the_day_before(self):
        a = {"a0000000": [10, "small"], "b0000000": [10, "small"], "c0000000": [20, "mid"]}
        day1 = [snapshot(h, active=a) for h in range(24)]
        day2 = [snapshot(24 + h, active={"a0000000": [10, "small"], "b0000000": [10, "small"]}) for h in range(24)]
        c = model.churn(day1 + day2)
        self.assertAlmostEqual(c["accounts"], 1 / 3)
        self.assertAlmostEqual(c["extensions"], 20 / 40)
        self.assertIsNone(model.churn(day2))

    def test_usage_trend_per_extension(self):
        day1 = [snapshot(h) for h in range(24)]
        day2 = [snapshot(24 + h, us=(1000, 6.6, 7.15), tf=(100, 2.75, 1.32)) for h in range(24)]   # +10 %
        g, hl, _ = model.usage_trend(day1 + day2, 2.0)
        self.assertAlmostEqual(g, 0.10, places=6)
        self.assertEqual(hl, 2.0)
        day3 = [snapshot(48 + h, us=(1000, 6.93, 7.5), tf=(100, 2.8875, 1.386)) for h in range(24)]  # +5 %
        g, hl, note = model.usage_trend(day1 + day2 + day3, 9.0)
        self.assertAlmostEqual(g, 0.05, places=6)
        self.assertAlmostEqual(hl, 1.0, places=6)          # 10 % -> 5 % in a day: half-life 1 day
        self.assertIn("fitted", note)

    def test_trend_multiplier(self):
        self.assertEqual(model.trend_multiplier(0.0, 2, 5), 1.0)
        self.assertAlmostEqual(model.trend_multiplier(0.1, 1e9, 1), math.exp(0.1), places=6)   # no fading
        self.assertLess(model.trend_multiplier(0.3, 2, 30), math.exp(0.3 * 2 / math.log(2)) + 1e-9)


class Bills(unittest.TestCase):
    def test_bill_adds_every_line(self):
        p = {"plan": 1, "included_extensions": 10, "included_us_minutes": 100, "extra_extension": 0.5,
             "local_number": 2, "toll_free_number": 3, "recording": 0.1, "intl_calling": 0.2,
             "us_per_min": 0.01, "uk_per_min": 0.02, "tf_in_per_min": 0.03, "signup_fee": 4}
        q = {"extensions": 12, "local_numbers": 1, "toll_free_numbers": 1, "recording": 1, "intl": 1,
             "us_min": 300, "uk_min": 10, "tf_in_min": 100}
        self.assertAlmostEqual(model.weekly_bill(p, q), 16.5)
        self.assertAlmostEqual(model.weekly_bill(p, q, includes_signup_fee=False), 12.5)

    def test_charge_ratio_per_minute_and_included_minutes(self):
        e = model.economics([snapshot(h) for h in range(24)])
        old = market()["providers"]["us"]["prices"]
        self.assertAlmostEqual(model.charge_ratio(e, old, old), 1.0)
        doubled_tf = dict(old, tf_in_per_min=old["tf_in_per_min"] * 2)
        # tf is 1.2 of 7.7 charged per hour
        self.assertAlmostEqual(model.charge_ratio(e, old, doubled_tf), (6.5 + 2.4) / 7.7)
        e["calls"]["us"]["included_min"] = 400.0 * 24           # 40 % of US minutes were free
        more = dict(old, included_us_minutes=old["included_us_minutes"] * 1.5)
        self.assertLess(model.charge_ratio(e, old, more), 1.0)

    def test_renewals_follow_list_cuts_and_minimum_charge(self):
        e = model.economics([snapshot(h) for h in range(24)])
        std = dict(market()["providers"]["us"]["prices"], plan=0.5, local_number=0.5)
        self.assertAlmostEqual(model.renewal_ratio(e, std), 0.5)        # $2/week per account -> $1
        cheap = dict(std, plan=0.1, local_number=0.1)
        self.assertEqual(model.renewal_ratio(e, cheap), 0.0)          # $0.20/week: under the minimum charge


class Shares(unittest.TestCase):
    def setUp(self):
        self.m = market()
        self.profiles = {"mid": {"extensions": 25, "local_numbers": 1, "toll_free_numbers": 0, "us_min": 3000}}

    def test_fit_recovers_known_parameters(self):
        truth = model.predict_shares(self.m, self.profiles, {"mid": 1.0}, 2.0, 0.5)
        for name, p in self.m["providers"].items():
            p["signup_share"] = truth.get(name, 0)
        b, g, err = model.fit_share_model(self.m, self.profiles, {"mid": 1.0})
        self.assertLess(err, 0.01)

    def test_calibration_reproduces_our_share(self):
        bias = model.calibrate_bias(self.m, self.profiles, {"mid": 1.0}, 2.0, 0.5, ["us"])
        p = model.predict_shares(self.m, self.profiles, {"mid": 1.0}, 2.0, 0.5, bias=bias)
        self.assertAlmostEqual(p["us"], self.m["providers"]["us"]["signup_share"], places=4)
        self.assertNotIn("provider-c", p)                      # grade F: no signups


class Project(unittest.TestCase):
    def setUp(self):
        self.e = model.economics([snapshot(h, signups=0, new_ext=0, topups=(0, 0)) for h in range(24)])
        self.e["did_renewals_per_day"] = 0
        self.now = T0 + dt.timedelta(days=2)

    def run_(self, signups=0.0, cloud=0.0, churn=0.0, growth=0.0):
        return model.project(self.e, 1000.0, self.now, self.now + dt.timedelta(days=1), {}, [signups] * 24, [1.0] * 24,
                             [0.0] * 24, 1.0, growth, 2.0, churn, churn, cloud)

    def test_no_signups_loses_the_call_margin_fees_and_vms(self):
        r = self.run_(cloud=48)
        # one day: charged 24*7.7 (minus 2.9 % and $0.30 per $5 refill), cost 24*8.5, VMs 48
        charged = 24 * 7.7
        expect = 1000 + charged - charged * model.CARD_PCT - charged / 5 * model.CARD_FIXED - 24 * 8.5 - 48
        self.assertAlmostEqual(r["final"], expect, places=6)

    def test_extensions_grow_with_signups_and_shrink_with_churn(self):
        self.e["new_mix"] = {"small": 1.0, "mid": 0.0, "large": 0.0}
        self.e["ext_per_new"] = {"small": 4.0, "mid": 0.0, "large": 0.0}
        base = sum(self.e["active_ext"].values())
        self.assertAlmostEqual(self.run_(signups=1)["ext_end"], base + 24 * 4, places=6)
        self.assertLess(self.run_(churn=0.1)["ext_end"], base)

    def test_growth_raises_cost(self):
        self.assertLess(self.run_(growth=0.2)["final"], self.run_()["final"])


class Search(unittest.TestCase):
    def setUp(self):
        self.snaps = [snapshot(h) for h in range(48)]
        self.s = settings()
        std = dict(market()["providers"]["us"]["prices"])
        self.s["our_prices"] = {"standard": std, "alt": dict(std, plan=0.5, us_per_min=0.005)}
        self.s["alt_window"] = {"start_hour": 0, "end_hour": 8}

    def test_rules_and_three_window_options(self):
        ctx = context(self.snaps, s=self.s)
        r = model.search_prices(ctx)
        rival = ctx.market["providers"]["provider-a"]["prices"]
        for k in model.LINES:
            self.assertLessEqual(r["prices"][k], rival[k] + 1e-9, k)
        for k in model.INCLUDED:
            self.assertGreaterEqual(r["prices"][k], rival[k], k)
        self.assertEqual(len(r["options"]), 3)
        for o in r["options"].values():
            for k in model.LINES:
                self.assertLessEqual(o["alt"][k], o["prices"][k] + 1e-9)

    def test_unsafe_when_cash_cannot_cover_the_floor(self):
        m = market()
        m["cash_total"] = -10_000
        self.assertFalse(model.search_prices(context(self.snaps, m=m, s=self.s))["safe"])

    def test_cheaper_night_list_wins_night_share(self):
        ctx = context(self.snaps, s=self.s)
        r = ctx.evaluate(ctx.cur_std, dict(ctx.cur_alt, plan=0.5))
        self.assertGreater(r["share_alt"], r["share_std"])

    def test_first_charge_waived_under_minimum(self):
        self.assertEqual(model.first_charge(0.49), 0.0)
        self.assertAlmostEqual(model.first_charge(0.99), 0.891)


class Backtest(unittest.TestCase):
    def test_exact_when_nothing_changes(self):
        snaps = [snapshot(h, signups=0, new_ext=0, topups=(0, 0)) for h in range(48)]
        bt = model.backtest(snaps, {})
        self.assertAlmostEqual(bt["calls cost"][2], 0.0, places=6)
        self.assertAlmostEqual(bt["calls charged"][2], 0.0, places=6)
        self.assertAlmostEqual(bt["active extensions"][2], 0.0, places=6)
        self.assertIsNone(model.backtest(snaps[:30], {}))


class Cloud(unittest.TestCase):
    def m(self, t, bal, topup=0.0):
        return {"taken_at": t, "bank": {"cloud": bal, "cloud_topups_since_last": topup}}

    def test_measured_from_balance_drop(self):
        h = [self.m("2026-12-01T00:00:00-05:00", 100), self.m("2026-12-01T12:00:00-05:00", 76)]
        self.assertEqual(model.cloud_cost_per_day(h, 99), (48.0, "measured over 12 h"))

    def test_topup_counted_or_interval_skipped(self):
        h = [self.m("2026-12-01T00:00:00-05:00", 100), self.m("2026-12-01T12:00:00-05:00", 76),
             self.m("2026-12-02T00:00:00-05:00", 176, topup=125)]
        self.assertAlmostEqual(model.cloud_cost_per_day(h, 99)[0], 50.0)
        h[-1]["bank"]["cloud_topups_since_last"] = 0
        self.assertAlmostEqual(model.cloud_cost_per_day(h, 99)[0], 48.0)
        self.assertEqual(model.cloud_cost_per_day(h[:1], 99), (99, "setting"))


class Clamp(unittest.TestCase):
    def test_alt_never_dearer(self):
        std = market()["providers"]["us"]["prices"]
        c = model.clamp_alt(dict(std, plan=9, included_extensions=1, us_per_min=0.001), std)
        self.assertEqual(c["plan"], std["plan"])
        self.assertEqual(c["included_extensions"], std["included_extensions"])
        self.assertEqual(c["us_per_min"], 0.001)


if __name__ == "__main__":
    unittest.main()
