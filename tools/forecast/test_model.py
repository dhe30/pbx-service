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


def snapshot(hour, signups=1, ext=10, us=(1000, 6.0, 6.5), tf=(100, 2.5, 1.2), topups=(10, 60.0)):
    """One synthetic hourly snapshot: us/tf = (minutes, cost, charge), topups = (n, amount)."""
    t0 = dt.datetime(2026, 12, 1, tzinfo=UTC) + dt.timedelta(hours=hour)
    calls = {"us": {"legs": 100, "billed_min": us[0], "included_min": 0, "cost": us[1], "charge": us[2]},
             "tf_in": {"legs": 10, "billed_min": tf[0], "included_min": 0, "cost": tf[1], "charge": tf[2]}}
    by_size = {s: {"accounts": n, "active_in_window": n, "extensions": n * e, "local_numbers": n,
                   "toll_free_numbers": 0, "recording": 0, "intl_calling": 0,
                   "usage_in_window": {"us": {"legs": 1, "min": us[0] * f, "cost": 0, "charge": 0},
                                       "tf_in": {"legs": 1, "min": tf[0] * f, "cost": 0, "charge": 0}}}
               for s, n, e, f in (("small", 60, 5, 0.1), ("mid", 30, 25, 0.3), ("large", 10, 200, 0.6))}
    return {
        "from": t0.strftime("%Y-%m-%dT%H:%M:%SZ"), "to": (t0 + dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "hourly": [{"hour": t0.strftime("%Y-%m-%dT%H:%M:%SZ"), "signups": signups, "new_extensions": ext,
                    "numbers_bought": {"local": signups, "toll_free": 0}, "calls": calls,
                    "payments": {"topup": {"n": topups[0], "amount": topups[1]}}, "failed_payments": 0}],
        "state": {"accounts": 100, "extensions": 2850, "credit_held": 500.0, "by_size": by_size,
                  "renewing_items": {"number_local": {"active": 100, "weekly": 100.0}}},
    }


def market():
    with open(os.path.join(HERE, "market.example.json")) as f:
        m = json.load(f)
    b = m["bank"]
    m["cash_total"] = b["bank"] + b["did"] + b["us_vendor"] + b["intl_vendor"] - b["loan_owed"]
    return m


def settings():
    with open(os.path.join(HERE, "settings.example.json")) as f:
        s = json.load(f)
    s["end"] = dt.datetime(2026, 12, 4, tzinfo=UTC)
    s["floor_final_from"] = dt.datetime(2026, 12, 3, tzinfo=UTC)
    return s


class Bills(unittest.TestCase):
    def test_bill_adds_every_line(self):
        p = {"plan": 1, "included_extensions": 10, "included_us_minutes": 100, "extra_extension": 0.5,
             "local_number": 2, "toll_free_number": 3, "recording": 0.1, "intl_calling": 0.2,
             "us_per_min": 0.01, "uk_per_min": 0.02, "tf_in_per_min": 0.03, "signup_fee": 4}
        q = {"extensions": 12, "local_numbers": 1, "toll_free_numbers": 1, "recording": 1, "intl": 1,
             "us_min": 300, "uk_min": 10, "tf_in_min": 100}
        # 1 + 2*0.5 + 2 + 3 + 0.1 + 0.2 + 200*0.01 + 10*0.02 + 100*0.03 + 4
        self.assertAlmostEqual(model.weekly_bill(p, q), 16.5)
        self.assertAlmostEqual(model.weekly_bill(p, q, includes_signup_fee=False), 12.5)

    def test_included_minutes_and_extensions_are_free(self):
        p = market()["providers"]["us"]["prices"]
        q = {"extensions": 5, "local_numbers": 0, "toll_free_numbers": 0, "us_min": 500}
        self.assertAlmostEqual(model.weekly_bill(p, q), p["plan"])


class Shares(unittest.TestCase):
    def test_fit_recovers_known_parameters(self):
        m = market()
        profiles = {"mid": {"extensions": 25, "local_numbers": 1, "toll_free_numbers": 0, "us_min": 3000}}
        mix = {"mid": 1.0}
        # Make the dashboard shares exactly what b=2, g=0.5 predicts, then fit them back.
        truth = model.predict_shares(m, profiles, mix, 2.0, 0.5)
        for name, p in m["providers"].items():
            p["signup_share"] = truth.get(name, 0)
        b, g, err = model.fit_share_model(m, profiles, mix)
        self.assertLess(err, 0.01)
        again = model.predict_shares(m, profiles, mix, b, g)
        for k in truth:
            self.assertAlmostEqual(again[k], truth[k], delta=0.02)

    def test_cheaper_bill_wins_share_and_grade_F_gets_none(self):
        m = market()
        profiles = {"mid": {"extensions": 25, "local_numbers": 1, "toll_free_numbers": 0, "us_min": 3000}}
        base = model.predict_shares(m, profiles, {"mid": 1}, 2, 0.5)
        cheaper = model.predict_shares(m, profiles, {"mid": 1}, 2, 0.5, {"us": {"us_per_min": 0.005}})
        self.assertGreater(cheaper["us"], base["us"])
        self.assertNotIn("provider-c", base)
        self.assertAlmostEqual(sum(base.values()), 1.0)


class Cash(unittest.TestCase):
    def test_economics_sums_hours(self):
        e = model.economics([snapshot(h) for h in range(24)])
        self.assertEqual(e["signups"], 24)
        self.assertAlmostEqual(e["usage_cost"], 24 * 8.5)
        self.assertAlmostEqual(e["usage_charge"], 24 * 7.7)
        self.assertAlmostEqual(e["did_renewals_per_day"], 100 * 1.5 / 7)

    def test_no_signups_loses_exactly_the_usage_margin_and_fees(self):
        e = model.economics([snapshot(h, signups=0, ext=0, topups=(0, 0)) for h in range(24)])
        e["did_renewals_per_day"] = 0
        now = dt.datetime(2026, 12, 2, tzinfo=UTC)
        _, low, final = model.project_cash(1000, e, [1 / 24] * 24, now + dt.timedelta(days=1), now, 0, 10,
                                           {"local": 1, "toll_free": 0}, 0, 0, 0)
        # one day: charged 24*7.7 in (minus 2.9 %), cost 24*8.5 out
        self.assertAlmostEqual(final, 1000 + 24 * 7.7 * (1 - model.CARD_PCT) - 24 * 8.5, places=6)
        self.assertLessEqual(low, 1000)

    def test_signups_bring_first_topups(self):
        e = model.economics([snapshot(h) for h in range(24)])
        now = dt.datetime(2026, 12, 2, tzinfo=UTC)
        end = now + dt.timedelta(days=2)
        _, _, none = model.project_cash(1000, e, [1 / 24] * 24, end, now, 0, 10, {"local": 1, "toll_free": 0}, 0, 10, 0)
        _, _, some = model.project_cash(1000, e, [1 / 24] * 24, end, now, 24, 10, {"local": 1, "toll_free": 0}, 0, 10, 0)
        self.assertGreater(some, none)


class Search(unittest.TestCase):
    def setUp(self):
        self.snaps = [snapshot(h) for h in range(48)]
        self.econ = model.economics(self.snaps)
        self.profiles, self.mix = model.profiles_from_snapshots(self.snaps)
        self.m, self.s = market(), settings()
        self.now = dt.datetime(2026, 12, 2, tzinfo=UTC)

    def test_never_above_the_rival_on_any_line(self):
        r = model.search_prices(self.m, self.s, self.econ, self.profiles, self.mix, 2.0, 0.5, self.now, self.s["end"])
        rival = self.m["providers"]["provider-a"]["prices"]
        for k in model.LINES:
            self.assertLessEqual(r["prices"][k], rival[k] + 1e-9, k)

    def test_unsafe_when_cash_cannot_cover_the_floor(self):
        self.m["cash_total"] = -10_000
        r = model.search_prices(self.m, self.s, self.econ, self.profiles, self.mix, 2.0, 0.5, self.now, self.s["end"])
        self.assertFalse(r["safe"])

    def test_signup_fee_free_items_under_minimum_charge(self):
        self.assertEqual(model.first_charge(0.49), 0.0)
        self.assertAlmostEqual(model.first_charge(0.99), 0.891)


if __name__ == "__main__":
    unittest.main()
