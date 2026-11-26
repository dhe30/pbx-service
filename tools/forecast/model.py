"""Forecast tool, step 2: the model. Pure functions, stdlib only, unit-tested (test_model.py).

Inputs
  snapshots  hourly JSON snapshots of our own data (collect.py)
  market     what only the course dashboard shows, entered per report (market.example.json):
             bank and vendor balances, every provider's price list, weekly bill estimates,
             share of new signups and reputation grade
  settings   our own limits (settings.example.json): cash floor, end date, how far a rival may cut

Outputs (report.py prints them)
  economics  last 24 h: cash in / out by kind, usage margin by call type
  customers  the dashboard's typical small / mid / large customer, fitted to every provider's bill
  shares     a signup-share model fitted to the dashboard: share ~ exp(-b * ln(bill) + g * grade)
  cash       hour-by-hour cash forecast to the end date, for: as now / a rival cuts / no signups.
             Existing accounts keep today's usage; each new account adds the usage of an account
             of its size; accounts leave at the observed churn rate.
  backtest   the same forecast run on the day before, compared with what actually happened
  prices     the price list that gains the most extensions by the end date while the
             "rival cuts" case keeps cash above the floor (or, if none does, the safest one)
"""
import datetime as dt
import math

GRADES = {"A": 4, "B": 3, "C": 2, "D": 1, "F": 0}
CARD_PCT, CARD_FIXED, MIN_CHARGE = 0.029, 0.30, 0.50
# What the DID provider charges us per number: first period (setup + 7 days), then per 7 days.
DID_FIRST = {"local": 1.50, "toll_free": 5.00}
DID_WEEK = {"local": 1.50, "toll_free": 3.00}
SIZES = ("small", "mid", "large")

# Price lines as the dashboard lists them. "step" = the smallest change worth making on that line.
LINES = {
    "plan": 0.01, "extra_extension": 0.01, "local_number": 0.01, "toll_free_number": 0.01,
    "recording": 0.01, "intl_calling": 0.01, "us_per_min": 0.0001, "uk_per_min": 0.001,
    "tf_in_per_min": 0.001,
}


def hours_in(snaps):
    return sum(len(s["hourly"]) for s in snaps)


def last_hours(snapshots, hours):
    """The newest snapshots covering `hours` hours (snapshots are normally one hour each)."""
    out, n = [], 0
    for s in reversed(snapshots):
        if n >= hours:
            break
        out.append(s)
        n += len(s["hourly"])
    return list(reversed(out))


# ---------------------------------------------------------------- our own data (snapshots) ----
def economics(snaps):
    """Sums of the hourly data in `snaps`, plus per-size usage per active account."""
    calls, pay = {}, {}
    out = {"hours": hours_in(snaps), "signups": 0, "new_extensions": 0, "numbers": {"local": 0, "toll_free": 0},
           "failed_payments": 0}
    size = {s: {"cost": 0.0, "charge": 0.0, "new": 0, "active_max": 0} for s in SIZES}
    for s in snaps:
        for h in s["hourly"]:
            out["signups"] += h["signups"]
            out["new_extensions"] += h["new_extensions"]
            out["failed_payments"] += h["failed_payments"]
            for k in ("local", "toll_free"):
                out["numbers"][k] += h["numbers_bought"][k]
            for cls, v in h["calls"].items():
                c = calls.setdefault(cls, {"legs": 0, "billed_min": 0.0, "included_min": 0.0, "cost": 0.0, "charge": 0.0})
                for k in c:
                    c[k] += v[k]
            for purpose, v in h["payments"].items():
                p = pay.setdefault(purpose, {"n": 0, "amount": 0.0})
                p["n"] += v["n"]
                p["amount"] += v["amount"]
        for name, v in s["state"].get("by_size", {}).items():
            z = size.setdefault(name, {"cost": 0.0, "charge": 0.0, "new": 0, "active_max": 0})
            z["cost"] += sum(u["cost"] for u in v["usage_in_window"].values())
            z["charge"] += sum(u["charge"] for u in v["usage_in_window"].values())
            z["new"] += v.get("new_in_window", 0)
            z["active_max"] = max(z["active_max"], v.get("active_in_window", 0))
    out["calls"], out["payments"], out["by_size"] = calls, pay, size
    out["usage_cost"] = sum(c["cost"] for c in calls.values())
    out["usage_charge"] = sum(c["charge"] for c in calls.values())
    out["cash_in"] = sum(p["amount"] for p in pay.values())
    out["card_fees"] = sum(p["n"] * CARD_FIXED + p["amount"] * CARD_PCT for p in pay.values())
    out["did_new"] = sum(out["numbers"][k] * DID_FIRST[k] for k in DID_FIRST)
    st = snaps[-1]["state"] if snaps else {}
    items = st.get("renewing_items") or {}
    out["did_renewals_per_day"] = sum(items.get(f"number_{k}", {}).get("active", 0) * DID_WEEK[k] for k in DID_WEEK) / 7
    out["state"] = st
    # Per active account and day, by size: what a new account of that size will cost and bring.
    per_day = 24 / max(1, out["hours"])
    for name, z in size.items():
        n = max(1, z["active_max"])
        z["cost_per_acct_day"] = z["cost"] * per_day / n
        z["charge_per_acct_day"] = z["charge"] * per_day / n
    new_total = sum(z["new"] for z in size.values())
    out["new_mix"] = {k: (z["new"] / new_total if new_total else 1 / len(size)) for k, z in size.items()}
    return out


def hour_profile(snapshots, days=3):
    """Share of a day's usage cost that falls in each New York hour (0-23), from recent history."""
    ny = dt.timezone(dt.timedelta(hours=-5))   # EST: no DST change before the course ends
    tot = [0.0] * 24
    for s in last_hours(snapshots, days * 24):
        for h in s["hourly"]:
            t = dt.datetime.strptime(h["hour"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
            tot[t.astimezone(ny).hour] += sum(c["cost"] for c in h["calls"].values())
    total = sum(tot)
    return [x / total for x in tot] if total else [1 / 24] * 24


# --------------------------------------------------------------------------------- bills ----
def weekly_bill(prices, profile, includes_signup_fee=True):
    """A customer's weekly bill at a provider's published prices.

    prices:  plan, included_extensions, included_us_minutes, extra_extension, local_number,
             toll_free_number, recording, intl_calling, us_per_min, uk_per_min, tf_in_per_min,
             signup_fee
    profile: extensions, local_numbers, toll_free_numbers, recording (0-1), intl (0-1),
             us_min, uk_min, tf_in_min (per week)
    """
    p, q = prices, profile
    bill = p["plan"]
    bill += max(0, q["extensions"] - p["included_extensions"]) * p["extra_extension"]
    bill += q["local_numbers"] * p["local_number"] + q["toll_free_numbers"] * p["toll_free_number"]
    bill += q.get("recording", 0) * p["recording"] + q.get("intl", 0) * p["intl_calling"]
    bill += max(0.0, q["us_min"] - p["included_us_minutes"]) * p["us_per_min"]
    bill += q.get("uk_min", 0) * p["uk_per_min"] + q.get("tf_in_min", 0) * p["tf_in_per_min"]
    if includes_signup_fee:
        bill += p.get("signup_fee", 0.0)
    return bill


def shape_from_snapshots(snaps):
    """Ratios that describe how our customers of each size use the service (from our data): share
    of numbers that are toll-free, add-on take-up, incoming toll-free and international minutes per
    US minute. The dashboard's bills then fix the scale (fit_dashboard_profiles)."""
    st = snaps[-1]["state"]["by_size"]
    mins = {s: {"us": 0.0, "tf_in": 0.0, "intl": 0.0} for s in st}
    for snap in snaps:
        for s, v in snap["state"]["by_size"].items():
            for cls in mins.get(s, {}):
                mins[s][cls] += v["usage_in_window"].get(cls, {}).get("min", 0.0)
    shape = {}
    for s, v in st.items():
        nums = v["local_numbers"] + v["toll_free_numbers"]
        us = max(1.0, mins[s]["us"])
        shape[s] = {"tf_share": v["toll_free_numbers"] / nums if nums else 0.15,
                    "recording": v["recording"] / max(1, v["accounts"]), "intl": v["intl_calling"] / max(1, v["accounts"]),
                    "tf_per_us": mins[s]["tf_in"] / us, "uk_per_us": mins[s]["intl"] / us}
    return shape


def _profile(shape, ext, numbers, us_min):
    return {"extensions": ext, "local_numbers": numbers * (1 - shape["tf_share"]),
            "toll_free_numbers": numbers * shape["tf_share"], "recording": shape["recording"],
            "intl": shape["intl"], "us_min": us_min, "tf_in_min": us_min * shape["tf_per_us"],
            "uk_min": us_min * shape["uk_per_us"]}


def fit_dashboard_profiles(market, shape):
    """For each size, the customer (extensions, numbers, weekly US minutes; other quantities in our
    ratios) whose bill at every provider's prices best matches the dashboard. Returns
    {size: (profile, mean abs error $, mean bill $)}."""
    all_exts = sorted({1, 2, 3, 5, 8, 10, 12, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100, 120, 150, 200, 250, 300, 400})
    bounds = {"small": (1, 10), "mid": (11, 40), "large": (41, 400)}   # our size buckets
    nums = [x / 2 for x in range(0, 21)]
    mins = [0] + [int(100 * 1.25 ** i) for i in range(0, 45)]          # 100 .. ~2.2 M per week
    out = {}
    for size in SIZES:
        provs = [p for p in market["providers"].values() if p.get("bills", {}).get(size) is not None]
        if not provs or size not in shape:
            continue
        best = None
        lo, hi = bounds[size]
        for e in [x for x in all_exts if lo <= x <= hi]:
            for n in nums:
                for m in mins:
                    prof = _profile(shape[size], e, n, m)
                    err = sum(abs(weekly_bill(p["prices"], prof) - p["bills"][size]) for p in provs) / len(provs)
                    if best is None or err < best[1]:
                        best = (prof, err)
        out[size] = (best[0], best[1], sum(p["bills"][size] for p in provs) / len(provs))
    return out


# -------------------------------------------------------------------------------- shares ----
def blended_bill(prices, profiles, mix):
    """Bill weighted by the mix of new customers' sizes."""
    return sum(mix[s] * weekly_bill(prices, profiles[s]) for s in mix if s in profiles)


GRADE_PRIOR, PRIOR_WEIGHT = 0.5, 0.05   # "each grade down costs a noticeable share" (dashboard)


def fit_share_model(markets, profiles, mix):
    """Fit share_i ~ exp(-b * ln(bill_i) + g * grade_i) to the dashboard's signup shares in every
    stored market snapshot (providers with a share > 0). With few snapshots the grade effect is
    not identifiable, so g is pulled gently towards GRADE_PRIOR. Grid search b in [0, 10],
    g in [0, 3]. Returns (b, g, rms error over all snapshots)."""
    if isinstance(markets, dict):
        markets = [markets]
    groups = []
    for m in markets:
        rows = [(math.log(max(0.01, blended_bill(p["prices"], profiles, mix))), GRADES[p["reputation"]], p["signup_share"])
                for p in m["providers"].values() if p.get("signup_share", 0) > 0]
        if len(rows) >= 2:
            groups.append(rows)
    best = (1.0, GRADE_PRIOR, float("inf"))
    if not groups:
        return best
    for bi in range(0, 101):
        b = bi / 10
        for gi in range(0, 31):
            g = gi / 10
            se, n = 0.0, 0
            for rows in groups:
                tot = sum(r[2] for r in rows)
                w = [math.exp(-b * lb + g * gr) for lb, gr, _ in rows]
                sw = sum(w)
                se += sum((wi / sw - s / tot) ** 2 for wi, (_, _, s) in zip(w, rows))
                n += len(rows)
            loss = se / n + PRIOR_WEIGHT * (g - GRADE_PRIOR) ** 2 / max(1, len(groups))
            if loss < best[2]:
                best = (b, g, loss)
    b, g, _ = best
    rms = math.sqrt(sum(sum((wi / sum(ws) - s / sum(r[2] for r in rows)) ** 2
                            for wi, (_, _, s) in zip(ws, rows))
                        for rows in groups
                        for ws in [[math.exp(-b * lb + g * gr) for lb, gr, _ in rows]])
                    / sum(len(r) for r in groups))
    return b, g, rms


def predict_shares(market, profiles, mix, b, g, overrides=None):
    """Signup share of every open provider (grade F gets none), with some prices overridden."""
    w = {}
    for name, p in market["providers"].items():
        if p.get("closed") or p["reputation"] == "F":
            continue
        prices = dict(p["prices"], **(overrides or {}).get(name, {}))
        w[name] = math.exp(-b * math.log(max(0.01, blended_bill(prices, profiles, mix))) + g * GRADES[p["reputation"]])
    sw = sum(w.values())
    return {k: v / sw for k, v in w.items()}


# ---------------------------------------------------------------------------------- cash ----
def trend_multiplier(growth_per_day, half_life_days, days):
    """Usage multiplier after `days` when usage grows `growth_per_day` now and that growth rate
    halves every `half_life_days` (load ramps do not compound forever)."""
    if not growth_per_day or half_life_days <= 0:
        return 1.0
    k = math.log(2) / half_life_days
    return math.exp(growth_per_day / k * (1 - math.exp(-k * days)))


def project_cash(start_cash, econ, profile_by_hour, end, now, signups_per_day, signup, churn_per_day=0.0,
                 usage_ratio=None, growth_per_day=0.0, half_life_days=2.0, cloud_per_day=0.0):
    """Hour-by-hour cash until `end`. Returns (list of (time, cash), minimum cash, final cash, totals).

    Prepaid cash model: top-ups refill what calls used (cash in = usage charged), renewals are
    invoiced to the card, each new account pays its first top-up and items; vendors cost what calls
    cost; numbers cost the DID provider; every card charge pays 2.9 % + $0.30.
    Usage: existing accounts keep today's (shrinking at churn_per_day); each new account adds the
    per-day usage of an active account of its size. usage_ratio scales the charge side (price change).
    cloud_per_day: what the VMs and volumes cost (paid from the cloud balance, part of total cash).
    """
    h = econ["hours"] or 24
    per_day = 24 / h
    r = usage_ratio if usage_ratio is not None else 1.0
    base_cost, base_charge = econ["usage_cost"] * per_day, econ["usage_charge"] * per_day * r
    refills_day = econ["payments"].get("topup", {}).get("n", 0) * per_day
    renew_in_day = econ["payments"].get("invoice", {}).get("amount", 0.0) * per_day
    renew_n_day = econ["payments"].get("invoice", {}).get("n", 0) * per_day
    did_renew_day = econ["did_renewals_per_day"]
    mix, size = econ["new_mix"], econ["by_size"]
    new_cost_day = sum(mix[s] * size[s]["cost_per_acct_day"] for s in mix)          # per new account
    new_charge_day = sum(mix[s] * size[s]["charge_per_acct_day"] for s in mix) * r
    nums = signup["numbers_per_signup"]
    did_first = sum(nums[k] * DID_FIRST[k] for k in DID_FIRST)
    did_week_new = sum(nums[k] * DID_WEEK[k] for k in DID_WEEK) / 7
    su = signups_per_day / 24
    cash, t, pts, low, new_accts = start_cash, now, [], start_cash, 0.0
    tot = {"usage_cost": 0.0, "usage_charge": 0.0, "cash_in": 0.0, "fees": 0.0, "did": 0.0, "cloud": 0.0}
    while t < end:
        days = (t - now).total_seconds() / 86400
        keep = (1 - churn_per_day) ** days * trend_multiplier(growth_per_day, half_life_days, days)
        frac = profile_by_hour[(t.hour - 5) % 24]               # this New York hour's share of a day
        usage_cost = (base_cost * keep + new_accts * new_cost_day) * frac
        usage_charge = (base_charge * keep + new_accts * new_charge_day) * frac
        cash_in = (usage_charge + renew_in_day * keep / 24 + new_accts * signup["renewal_per_day"] / 24
                   + su * (signup["first_topup"] + signup["revenue"]))
        charges = refills_day * keep * frac + renew_n_day * keep / 24 + su * (1 + sum(nums.values()))
        fees = charges * CARD_FIXED + cash_in * CARD_PCT
        did = su * did_first + (did_renew_day * keep + new_accts * did_week_new) / 24
        cash += cash_in - fees - usage_cost - did - cloud_per_day / 24
        for k, v in (("usage_cost", usage_cost), ("usage_charge", usage_charge), ("cash_in", cash_in),
                     ("fees", fees), ("did", did), ("cloud", cloud_per_day / 24)):
            tot[k] += v
        low = min(low, cash)
        pts.append((t, cash))
        new_accts = new_accts * (1 - churn_per_day / 24) + su
        t += dt.timedelta(hours=1)
    return pts, low, cash, tot


# ------------------------------------------------------------------------- what-if inputs ----
def first_charge(price, prorate=0.9):
    """What a new customer pays for an item on signup: prorated, waived under the minimum charge."""
    amount = price * prorate
    return amount if amount >= MIN_CHARGE else 0.0


def signup_inputs(econ, our_prices):
    """Per-signup averages from the data, at our current (or proposed) prices."""
    n = max(1, econ["signups"])
    nums = {k: econ["numbers"][k] / n for k in ("local", "toll_free")}
    topup = econ["payments"].get("topup", {}).get("amount", 0.0)
    items_week = our_prices["plan"] + nums["local"] * our_prices["local_number"] + nums["toll_free"] * our_prices["toll_free_number"]
    return {
        "ext_per_signup": econ["new_extensions"] / n,
        "numbers_per_signup": nums,
        "revenue": (first_charge(our_prices["plan"]) + nums["local"] * first_charge(our_prices["local_number"])
                    + nums["toll_free"] * first_charge(our_prices["toll_free_number"])),
        # Renewal invoices are one charge per account per week, waived under the minimum charge.
        "renewal_per_day": (items_week if items_week >= MIN_CHARGE else 0.0) / 7,
        # Top-ups beyond refilling what calls used = new accounts' first top-ups.
        "first_topup": max(0.0, topup - econ["usage_charge"]) / n,
    }


def usage_ratio(econ, old, new):
    """How the charge side of today's calls changes with new per-minute prices (same minutes)."""
    key = {"us": "us_per_min", "tf_in": "tf_in_per_min", "intl": "uk_per_min"}
    before = sum(c["charge"] for c in econ["calls"].values())
    after = sum(c["charge"] * (new[key[k]] / old[key[k]] if k in key and old.get(key[k]) else 1.0)
                for k, c in econ["calls"].items())
    return after / before if before else 1.0


def evaluate(market, settings, econ, profiles, mix, b, g, ours, now, end, cut_rival=False, signups_on=True):
    """Cash path and extension gain for our price list `ours` (a full price dict)."""
    us, rival = settings["us"], settings["rival"]
    over = {us: ours}
    if cut_rival:
        rp = market["providers"][rival]["prices"]
        over[rival] = {k: round(rp[k] * (1 - settings["rival_cut"]), 6) for k in LINES if k in rp}
    share_now = market["providers"][us]["signup_share"]
    market_signups = econ["signups"] / max(0.01, share_now) * 24 / max(1, econ["hours"])
    share = predict_shares(market, profiles, mix, b, g, over).get(us, 0.0)
    spd = market_signups * share if signups_on else 0.0
    si = signup_inputs(econ, ours)
    pts, low, final, _ = project_cash(market["cash_total"], econ, settings.get("_hour_profile") or [1 / 24] * 24,
                                   end, now, spd, si, settings.get("churn_per_day", 0.0),
                                   usage_ratio(econ, market["providers"][us]["prices"], ours),
                                   settings.get("_growth_per_day", 0.0), settings.get("growth_half_life_days", 2.0),
                                   settings.get("_cloud_per_day", settings.get("cloud_cost_per_day", 0.0)))
    days = (end - now).total_seconds() / 86400
    return {"share": share, "signups_per_day": spd, "ext_gain": spd * si["ext_per_signup"] * days,
            "low": low, "final": final, "points": pts}


def floor_at(settings, t):
    return settings["floor_final"] if t >= settings["floor_final_from"] else settings["floor"]


def safe(result, settings):
    """Cash never below the floor in force at that time."""
    return all(c >= floor_at(settings, t) for t, c in result["points"])


def search_prices(market, settings, econ, profiles, mix, b, g, now, end):
    """Coordinate search over our price lines. Rules: never above the rival on any line; candidates
    are the rival's price and 1-2 steps under it, the current price and the minimum allowed.
    A list is acceptable if cash stays above the floor even when the rival cuts every line by
    settings['rival_cut']. Among acceptable lists: most extensions gained, and when two are within
    1 % the one with more cash left wins (never lower than needed). If no list is acceptable: the
    one whose lowest cash (rival cuts) is highest."""
    us, rival = settings["us"], settings["rival"]
    cur = dict(market["providers"][us]["prices"])
    rp = market["providers"][rival]["prices"]
    mins = settings.get("min_prices", {})

    def score(p):
        return (evaluate(market, settings, econ, profiles, mix, b, g, p, now, end),
                evaluate(market, settings, econ, profiles, mix, b, g, p, now, end, cut_rival=True))

    def better(a, c):  # (prices, base, stress)
        sa, sc = safe(a[2], settings), safe(c[2], settings)
        if sa != sc:
            return sa
        if not sa:
            return a[2]["low"] > c[2]["low"]
        if abs(a[1]["ext_gain"] - c[1]["ext_gain"]) <= 0.01 * max(1.0, c[1]["ext_gain"]):
            return a[1]["final"] > c[1]["final"]
        return a[1]["ext_gain"] > c[1]["ext_gain"]

    best = (cur, *score(cur))
    for _ in range(2):
        for line, step in LINES.items():
            if line not in rp or line not in cur:
                continue
            for c in sorted({cur[line], rp[line], rp[line] - step, rp[line] - 2 * step, mins.get(line, step)}):
                c = round(c, 6)
                if c > rp[line] or c < mins.get(line, step) or c == best[0][line]:
                    continue
                p = dict(best[0], **{line: c})
                cand = (p, *score(p))
                if better(cand, best):
                    best = cand
    return {"prices": best[0], "base": best[1], "stress": best[2], "safe": safe(best[2], settings),
            "changes": {k: (cur[k], best[0][k]) for k in cur if cur[k] != best[0][k]}}


# ----------------------------------------------------------------------------- cloud cost ----
def cloud_cost_per_day(history, fallback):
    """VM + volume cost per day, measured from the cloud balance in successive market snapshots:
    (earlier balance + top-ups in between - later balance) / days. An interval where the balance
    rose without a recorded top-up (bank.cloud_topups_since_last) is skipped. Uses the newest
    measurable interval of at least 1 h; else `fallback` (settings.cloud_cost_per_day).
    Returns (cost per day, "measured over N h" | "setting")."""
    pts = sorted((m for m in history if m.get("bank", {}).get("cloud") is not None),
                 key=lambda m: dt.datetime.fromisoformat(m["taken_at"]))
    for a, b in reversed(list(zip(pts, pts[1:]))):
        ta, tb = (dt.datetime.fromisoformat(m["taken_at"]) for m in (a, b))
        hours = (tb - ta).total_seconds() / 3600
        spent = a["bank"]["cloud"] + b["bank"].get("cloud_topups_since_last", 0.0) - b["bank"]["cloud"]
        if hours >= 1 and spent > 0:
            return spent / hours * 24, f"measured over {hours:.0f} h"
    return fallback, "setting"


# ------------------------------------------------------------------------------- backtest ----
def actual_net(e):
    """What really happened to cash in a period: payments in, minus card fees, calls and numbers."""
    return e["cash_in"] - e["card_fees"] - e["usage_cost"] - e["did_new"] - e["did_renewals_per_day"] * e["hours"] / 24


def backtest(snapshots, settings, growth_per_day=0.0):
    """Forecast the last 24 h from the 24 h before it (given the signups that really happened) and
    compare with what happened. Returns {name: (forecast, actual, error %)} or None if < 48 h.
    With growth_per_day it tests the trend model too (report.py passes the trend measured on the
    days before, when there are 72 h)."""
    if hours_in(snapshots) < 48:
        return None
    day2 = last_hours(snapshots, 24)
    day1 = last_hours(snapshots[:len(snapshots) - len(day2)], 24)
    e1, e2 = economics(day1), economics(day2)
    si = signup_inputs(e1, {"plan": 0, "local_number": 0, "toll_free_number": 0})
    n1 = max(1, e1["signups"])
    items = e1["cash_in"] - e1["payments"].get("topup", {}).get("amount", 0) - e1["payments"].get("invoice", {}).get("amount", 0)
    si["revenue"], si["renewal_per_day"] = items / n1, 0.0
    start = dt.datetime.strptime(day2[0]["hourly"][0]["hour"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    _, _, net, tot = project_cash(0.0, e1, hour_profile(day1, 1), start + dt.timedelta(hours=24), start,
                                  e2["signups"], si, settings.get("churn_per_day", 0.0), None,
                                  growth_per_day, settings.get("growth_half_life_days", 2.0))

    def row(pred, act):
        return (pred, act, (pred - act) / abs(act) * 100 if act else float("nan"))
    # Growth of existing usage the flat model missed: the trend the forecast applies from now on.
    missed = (e2["usage_cost"] - tot["usage_cost"]) / max(1.0, e1["usage_cost"] * 24 / max(1, e1["hours"]))
    return {"_growth_per_day": missed,
            "calls cost": row(tot["usage_cost"], e2["usage_cost"]),
            "calls charged": row(tot["usage_charge"], e2["usage_charge"]),
            "cash in": row(tot["cash_in"], e2["cash_in"]),
            "net cash": row(net, actual_net(e2))}
