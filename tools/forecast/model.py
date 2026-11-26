"""Forecast tool, step 2: the model (v2). Pure functions, stdlib only, unit-tested (test_model.py).

Inputs
  snapshots  hourly JSON snapshots of our own data (collect.py, snapshot.sql)
  market     what only the course dashboard shows, entered per report (market.example.json)
  settings   our limits and price lists (settings.example.json)

How the forecast works (hour by hour until the end date)
  base       the last 24 h, measured exactly: accounts active in the day (union of the hourly
             active sets), their extensions by customer size, call cost and charge PER ACTIVE
             EXTENSION by size, payments, numbers, first top-ups, renewals
  growth     extensions grow from new accounts (signups x extensions a new account brings, by size)
             and from active accounts adding extensions (upgrade rate); they shrink with churn
             (accounts active the day before but not in the last day, weighted by extensions)
  usage      active extensions x usage per extension x a trend: per-extension usage grew g per day
             recently; g fades with a half-life (fitted when 3 days exist, else the setting)
  cash       calls are prepaid: top-ups refill what calls used (cash in = calls charged); new
             accounts pay a first top-up and their first items; renewals are invoiced weekly at the
             lower of the item's price and the current list (so list cuts lower them too); vendors
             cost what calls cost; numbers cost the DID provider (first period + renewals); VMs and
             volumes cost what the cloud balance shows; every card charge pays 2.9 % + $0.30
  signups    market signups per hour (scaled from ours and our share) x our share, from a model
             fitted to the dashboard (bills recomputed from every provider's prices + grades),
             calibrated so it reproduces our current share; the list in force each hour (two lists)
  goal       leaderboard extensions on the end date (our active extensions, calibrated to the
             dashboard's count), and the gap to the rival, whose growth is measured from the
             leaderboard history and scaled with its share
  ranges     expected / low / high: growth trend as measured, off, and fading twice as slowly;
             signup sensitivity +-30 %
  checks     backtest: the same model run on the day before, compared with what happened
"""
import datetime as dt
import math

GRADES = {"A": 4, "B": 3, "C": 2, "D": 1, "F": 0}
CARD_PCT, CARD_FIXED, MIN_CHARGE = 0.029, 0.30, 0.50
# What the DID provider charges us per number: first period (setup + 7 days), then per 7 days.
DID_FIRST = {"local": 1.50, "toll_free": 5.00}
DID_WEEK = {"local": 1.50, "toll_free": 3.00}
SIZES = ("small", "mid", "large")
CLASSES = ("us", "tf_in", "intl")
NY = dt.timezone(dt.timedelta(hours=-5))           # EST: no DST change before the course ends

# Price lines as the dashboard lists them. "step" = the smallest change worth making on that line.
LINES = {
    "plan": 0.01, "extra_extension": 0.01, "local_number": 0.01, "toll_free_number": 0.01,
    "recording": 0.01, "intl_calling": 0.01, "us_per_min": 0.0001, "uk_per_min": 0.001,
    "tf_in_per_min": 0.001,
}
INCLUDED = ("included_extensions", "included_us_minutes")
PER_MIN = {"us": "us_per_min", "tf_in": "tf_in_per_min", "intl": "uk_per_min"}
# Renewing item kinds (account_items, snapshot.renewing_items) -> the list price that caps them.
ITEM_PRICE = {"plan": "plan", "extension": "extra_extension", "number_local": "local_number",
              "number_toll_free": "toll_free_number", "recording": "recording", "intl_calling": "intl_calling"}


def ts_hour(s):
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


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


def day_windows(snapshots, days):
    """Up to `days` consecutive 24 h windows, newest last: [[snaps of day -n], ..., [snaps of last day]]."""
    out, rest = [], list(snapshots)
    for _ in range(days):
        if hours_in(rest) < 24:
            break
        d = last_hours(rest, 24)
        out.insert(0, d)
        rest = rest[:len(rest) - len(d)]
    return out


# ------------------------------------------------------------------------------- the base day ----
def size_of(ext):
    return "small" if ext <= 10 else "mid" if ext <= 40 else "large"


def economics(snaps):
    """One period of our own data (normally 24 hourly snapshots), measured exactly where the
    snapshots allow it. Schema-1 snapshots (no active sets) fall back to per-window estimates."""
    calls, pay = {}, {}
    out = {"hours": hours_in(snaps), "signups": 0, "new_extensions": 0, "numbers": {"local": 0, "toll_free": 0},
           "failed_payments": 0}
    usage = {s: {c: {"cost": 0.0, "charge": 0.0, "min": 0.0} for c in CLASSES} for s in SIZES}
    active, new, active_max = {}, {}, {s: 0 for s in SIZES}
    for snap in snaps:
        for h in snap["hourly"]:
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
        st = snap["state"]
        for name, v in st.get("by_size", {}).items():
            active_max[name] = max(active_max.get(name, 0), v.get("active_in_window", 0))
            for cls in CLASSES:
                u = v["usage_in_window"].get(cls)
                if u:
                    usage[name][cls]["cost"] += u["cost"]
                    usage[name][cls]["charge"] += u["charge"]
                    usage[name][cls]["min"] += u.get("min", 0.0)
        active.update(st.get("active") or {})           # newest value per account wins
        new.update(st.get("new_accounts") or {})
    for k in new:                                      # extensions a new account has by the end
        if k in active:
            new[k] = active[k]
    out["calls"], out["payments"] = calls, pay
    out["usage_cost"] = sum(c["cost"] for c in calls.values())
    out["usage_charge"] = sum(c["charge"] for c in calls.values())
    out["cash_in"] = sum(p["amount"] for p in pay.values())
    out["card_fees"] = sum(p["n"] * CARD_FIXED + p["amount"] * CARD_PCT for p in pay.values())
    out["did_new"] = sum(out["numbers"][k] * DID_FIRST[k] for k in DID_FIRST)
    st = snaps[-1]["state"] if snaps else {}
    out["state"] = st
    items = st.get("renewing_items") or {}
    out["did_renewals_per_day"] = sum(items.get(f"number_{k}", {}).get("active", 0) * DID_WEEK[k] for k in DID_WEEK) / 7
    out["exact"] = bool(active) or not snaps or "active" in snaps[-1]["state"]

    # Active accounts and extensions in the period, by size.
    acc = {s: 0 for s in SIZES}
    ext = {s: 0 for s in SIZES}
    if out["exact"]:
        for e, size in active.values():
            acc[size] += 1
            ext[size] += e
    else:                                              # schema 1: busiest window, approximate
        by = st.get("by_size", {})
        for s in SIZES:
            v = by.get(s, {})
            acc[s] = active_max.get(s, 0)
            ext[s] = v.get("extensions", 0) * acc[s] / max(1, v.get("accounts", 1))
    out["active_accounts"], out["active_ext"], out["active_ids"] = acc, ext, active
    per_day = 24 / max(1, out["hours"])
    out["per_ext"] = {s: {c: {k: usage[s][c][k] * per_day / max(1, ext[s]) for k in ("cost", "charge", "min")}
                          for c in CLASSES} for s in SIZES}
    # New accounts: how many extensions they bring, by size.
    n_new = {s: 0 for s in SIZES}
    e_new = {s: 0 for s in SIZES}
    for e, size in new.values():
        n_new[size] += 1
        e_new[size] += e
    tot_new = sum(n_new.values())
    out["new_mix"] = {s: (n_new[s] / tot_new if tot_new else 1 / 3) for s in SIZES}
    out["ext_per_new"] = {s: (e_new[s] / n_new[s] if n_new[s] else 0.0) for s in SIZES}
    from_new = sum(e_new.values()) if new else 0
    out["upgrades_per_day"] = max(0.0, out["new_extensions"] - from_new) * per_day
    return out


def churn(snapshots):
    """Accounts active in the day before the last but not in the last day (extension-weighted and
    by count), as a fraction per day. None without two days of exact snapshots."""
    days = day_windows(snapshots, 2)
    if len(days) < 2:
        return None
    a, b = economics(days[0]), economics(days[1])
    if not (a["exact"] and b["exact"]) or not a["active_ids"]:
        return None
    gone = [v for k, v in a["active_ids"].items() if k not in b["active_ids"]]
    tot_ext = sum(e for e, _ in a["active_ids"].values()) or 1
    return {"accounts": len(gone) / len(a["active_ids"]), "extensions": sum(e for e, _ in gone) / tot_ext,
            "gone": len(gone)}


def usage_trend(snapshots, default_half_life):
    """Growth per day of call cost per active extension (last day vs the one before) and how fast it
    fades: with three days the half-life is fitted from the two growth rates, else the setting.
    Returns (growth per day, half-life days, note)."""
    days = day_windows(snapshots, 3)
    if len(days) < 2:
        return 0.0, default_half_life, "needs 48 h"

    def per_ext_cost(d):
        e = economics(d)
        n = sum(e["active_ext"].values())
        return e["usage_cost"] / n if n else 0.0
    costs = [per_ext_cost(d) for d in days]
    rates = [b / a - 1 for a, b in zip(costs, costs[1:]) if a > 0]
    if not rates:
        return 0.0, default_half_life, "no usage"
    g = max(-0.5, min(1.0, rates[-1]))
    if len(rates) >= 2 and rates[-2] > rates[-1] > 0:
        hl = max(0.5, min(10.0, math.log(2) / math.log(rates[-2] / rates[-1])))
        return g, hl, "half-life fitted from 3 days"
    return g, default_half_life, "half-life from settings"


def trend_multiplier(growth_per_day, half_life_days, days):
    """Usage multiplier after `days` when usage grows `growth_per_day` now and that growth rate
    halves every `half_life_days` (load ramps do not compound forever)."""
    if not growth_per_day or half_life_days <= 0:
        return 1.0
    k = math.log(2) / half_life_days
    return math.exp(growth_per_day / k * (1 - math.exp(-k * days)))


def hour_profile(snapshots, days=3, key="cost"):
    """Share of a day's call cost (key="cost") or signups (key="signups") in each New York hour."""
    tot = [0.0] * 24
    for s in last_hours(snapshots, days * 24):
        for h in s["hourly"]:
            v = h["signups"] if key == "signups" else sum(c["cost"] for c in h["calls"].values())
            tot[ts_hour(h["hour"]).astimezone(NY).hour] += v
    total = sum(tot)
    return [x / total for x in tot] if total else [1 / 24] * 24


def signup_hour_profile(snapshots, days=3):
    return hour_profile(snapshots, days, key="signups")


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


def predict_shares(market, profiles, mix, b, g, overrides=None, bias=None):
    """Signup share of every open provider (grade F gets none), with some prices overridden.
    bias: {provider: weight multiplier} (calibration: what the bill and grade don't explain)."""
    w = {}
    for name, p in market["providers"].items():
        if p.get("closed") or p["reputation"] == "F":
            continue
        prices = dict(p["prices"], **(overrides or {}).get(name, {}))
        w[name] = math.exp(-b * math.log(max(0.01, blended_bill(prices, profiles, mix))) + g * GRADES[p["reputation"]])
        w[name] *= (bias or {}).get(name, 1.0)
    sw = sum(w.values())
    return {k: v / sw for k, v in w.items()}


def calibrate_bias(market, profiles, mix, b, g, names):
    """Weight multipliers so the model reproduces the dashboard's current shares of `names`
    exactly (the rest of the market absorbs the difference)."""
    bias = {}
    for _ in range(20):
        pred = predict_shares(market, profiles, mix, b, g, bias=bias)
        for n in names:
            obs = market["providers"][n].get("signup_share", 0)
            if n in pred and 0 < obs < 1 and 0 < pred[n] < 1:
                bias[n] = bias.get(n, 1.0) * (obs / (1 - obs)) / (pred[n] / (1 - pred[n]))
    return bias


# ---------------------------------------------------------------------------- price lists ----
def in_window(ny_hour, settings):
    w = settings.get("alt_window")
    return bool(w) and w["start_hour"] <= ny_hour < w["end_hour"]


def our_lists(market, settings):
    """Our current (standard, alternate) price lists: settings.our_prices if given, else the
    dashboard's (then both the same)."""
    op = settings.get("our_prices") or {}
    std = op.get("standard") or market["providers"][settings["us"]]["prices"]
    return dict(std), dict(op.get("alt") or std)


def clamp_alt(alt, std):
    """The alternate list is never dearer than the standard one: price lines at most the standard
    price, included quantities at least the standard ones."""
    out = dict(alt)
    for k in LINES:
        if k in std and k in out:
            out[k] = min(out[k], std[k])
    for k in INCLUDED:
        if k in std and k in out:
            out[k] = max(out[k], std[k])
    return out


def first_charge(price, prorate=0.9):
    """What a new customer pays for an item on signup: prorated, waived under the minimum charge."""
    amount = price * prorate
    return amount if amount >= MIN_CHARGE else 0.0


def charge_ratio(econ, old, new):
    """Calls charged at list `new` / charged at list `old` (same calls): per-minute prices by call
    type, and included US minutes (more included minutes = fewer billed)."""
    before = econ["usage_charge"]
    if not before:
        return 1.0
    after = 0.0
    for cls, c in econ["calls"].items():
        k = PER_MIN.get(cls)
        r = new[k] / old[k] if k and old.get(k) else 1.0
        ch = c["charge"] * r
        if cls == "us" and old.get("included_us_minutes") and c["billed_min"] > c["included_min"]:
            # included minutes are free; scale them with the allowance, billed minutes shrink alike
            inc_new = min(c["billed_min"], c["included_min"] * new["included_us_minutes"] / old["included_us_minutes"])
            ch *= (c["billed_min"] - inc_new) / (c["billed_min"] - c["included_min"])
        after += ch
    return after / before


def renewal_ratio(econ, std):
    """Weekly renewals at list `std`: every renewing item renews at the lower of its own price and
    the list (current state), relative to today's renewal value. Accounts whose items come to less
    than the minimum charge pay nothing (approximated per average account)."""
    items = econ["state"].get("renewing_items") or {}
    cur = sum(v["weekly"] for v in items.values())
    new = 0.0
    for kind, v in items.items():
        line = ITEM_PRICE.get(kind)
        avg = v["weekly"] / v["active"] if v["active"] else 0.0
        new += v["active"] * (min(avg, std[line]) if line in std else avg)
    plans = (items.get("plan") or {}).get("active", 0)
    if plans and new / plans < MIN_CHARGE:
        new = 0.0
    return new / cur if cur else 1.0


def signup_inputs(econ, prices):
    """Per-signup averages from the base day, at a given price list."""
    n = max(1, econ["signups"])
    nums = {k: econ["numbers"][k] / n for k in ("local", "toll_free")}
    topup = econ["payments"].get("topup", {}).get("amount", 0.0)
    return {
        "numbers": nums,
        "revenue": (first_charge(prices["plan"]) + nums["local"] * first_charge(prices["local_number"])
                    + nums["toll_free"] * first_charge(prices["toll_free_number"])),
        # Top-ups beyond refilling what calls used = new accounts' first top-ups.
        "first_topup": max(0.0, topup - econ["usage_charge"]) / n,
    }


# --------------------------------------------------------------------------------- forecast ----
def project(econ, start_cash, now, end, settings, signups_by_hour, ratio_by_hour, revenue_by_hour,
            renew_ratio=1.0, growth=0.0, half_life=2.0, churn_ext=0.0, churn_acct=None, cloud_per_day=0.0,
            usage_profile=None):
    """Hour-by-hour cash and active extensions until `end`. Per-hour inputs are indexed by New York
    hour (0-23). Returns {"points": [(t, cash)], "low", "final", "ext_end", "totals"}."""
    per_day = 24 / max(1, econ["hours"])
    prof = usage_profile or [1 / 24] * 24
    ext = dict(econ["active_ext"])
    ext0 = max(1.0, sum(ext.values()))
    acc0 = max(1, sum(econ["active_accounts"].values()))
    acc = float(acc0)
    churn_acct = churn_ext if churn_acct is None else churn_acct
    pe = econ["per_ext"]
    ext_new, mix = econ["ext_per_new"], econ["new_mix"]
    upgrade_rate = econ["upgrades_per_day"] / ext0                   # per day, relative to the base
    topup = econ["payments"].get("topup", {"n": 0, "amount": 0.0})
    refill_size = topup["amount"] / topup["n"] if topup["n"] else 5.0
    inv = econ["payments"].get("invoice", {"n": 0, "amount": 0.0})
    renew_in, renew_n = inv["amount"] * per_day * renew_ratio, inv["n"] * per_day
    did_renew = econ["did_renewals_per_day"]
    si = signup_inputs(econ, {"plan": 0, "local_number": 0, "toll_free_number": 0})
    nums = si["numbers"]
    did_first = sum(nums[k] * DID_FIRST[k] for k in DID_FIRST)
    tot = {k: 0.0 for k in ("usage_cost", "usage_charge", "cash_in", "fees", "did", "cloud")}
    cash, low, pts, t = start_cash, start_cash, [], now
    while t < end:
        days = (t - now).total_seconds() / 86400
        m = trend_multiplier(growth, half_life, days)
        h = t.astimezone(NY).hour
        frac = prof[h]
        cost = sum(ext[s] * sum(pe[s][c]["cost"] for c in CLASSES) for s in SIZES) * m * frac
        charge = sum(ext[s] * sum(pe[s][c]["charge"] for c in CLASSES) for s in SIZES) * m * frac * ratio_by_hour[h]
        su = signups_by_hour[h]
        active_share = acc / acc0
        cash_in = charge + su * (si["first_topup"] + revenue_by_hour[h]) + renew_in * active_share / 24
        charges = charge / refill_size + su * (1 + sum(nums.values())) + renew_n * active_share / 24
        fees = charges * CARD_FIXED + cash_in * CARD_PCT
        did = su * did_first + did_renew * active_share / 24
        cloud = cloud_per_day / 24
        cash += cash_in - fees - cost - did - cloud
        for k, v in (("usage_cost", cost), ("usage_charge", charge), ("cash_in", cash_in), ("fees", fees),
                     ("did", did), ("cloud", cloud)):
            tot[k] += v
        low = min(low, cash)
        pts.append((t, cash))
        for s in SIZES:                                             # extensions: new, upgrades, churn
            ext[s] += su * mix[s] * ext_new[s] + ext[s] * (upgrade_rate - churn_ext) / 24
        acc += su - acc * churn_acct / 24
        t += dt.timedelta(hours=1)
    return {"points": pts, "low": low, "final": cash, "ext_end": sum(ext.values()), "totals": tot}


def rival_rate(history, rival):
    """The rival's leaderboard extensions per day, from the oldest and newest market snapshots at
    least 6 h apart. None if the history is too short."""
    pts = sorted(((dt.datetime.fromisoformat(m["taken_at"]), m["providers"][rival]["extensions"])
                  for m in history if rival in m.get("providers", {})), key=lambda p: p[0])
    if len(pts) < 2 or (pts[-1][0] - pts[0][0]).total_seconds() < 6 * 3600:
        return None
    return (pts[-1][1] - pts[0][1]) / ((pts[-1][0] - pts[0][0]).total_seconds() / 86400)


class Context:
    """Everything a forecast needs that does not depend on the price list being tried."""

    def __init__(self, market, settings, econ, profiles, b, g, now, end, history=None, trend=(0.0, 2.0),
                 churn_rates=None):
        self.market, self.settings, self.econ, self.profiles = market, settings, econ, profiles
        self.b, self.g, self.now, self.end = b, g, now, end
        self.mix = econ["new_mix"]
        self.us, self.rival = settings["us"], settings["rival"]
        self.cur_std, self.cur_alt = our_lists(market, settings)
        self.win = [in_window(h, settings) for h in range(24)]
        self.sp = settings.get("_signup_profile") or [1 / 24] * 24
        self.usage_profile = settings.get("_hour_profile") or [1 / 24] * 24
        self.growth, self.half_life = trend
        self.churn = churn_rates or {"extensions": settings.get("churn_per_day", 0.0),
                                     "accounts": settings.get("churn_per_day", 0.0)}
        self.cloud = settings.get("_cloud_per_day", settings.get("cloud_cost_per_day", 0.0))
        # The dashboard's share was observed under the list in force when it was taken.
        taken = dt.datetime.fromisoformat(market["taken_at"]).astimezone(NY)
        self.observed_list = self.cur_alt if in_window(taken.hour, settings) else self.cur_std
        cal = dict(market, providers=dict(market["providers"]))
        cal["providers"][self.us] = dict(market["providers"][self.us], prices=self.observed_list)
        self.bias = calibrate_bias(cal, profiles, self.mix, b, g, [self.us])
        # Leaderboard extensions per active extension of ours (the dashboard counts what it counts).
        ours = sum(econ["active_ext"].values())
        self.lb_factor = market["providers"][self.us]["extensions"] / ours if ours else 1.0
        self.rival_rate = rival_rate(history or [market], self.rival)

    def shares(self, std, alt, cut_rival=False, sens=1.0):
        rival_over = {}
        if cut_rival:
            rp = self.market["providers"][self.rival]["prices"]
            rival_over = {self.rival: {k: round(rp[k] * (1 - self.settings["rival_cut"]), 6) for k in LINES if k in rp}}

        def one(ours):
            p = predict_shares(self.market, self.profiles, self.mix, self.b * sens, self.g,
                               dict(rival_over, **{self.us: ours}), self.bias)
            return p.get(self.us, 0.0), p.get(self.rival, 0.0)
        return one(std), one(alt)

    def market_signups_per_day(self):
        """All new customers per day in the market: ours over our (model) share, hour by hour."""
        (s_std, _), (s_alt, _) = self.shares(self.cur_std, self.cur_alt)
        ours = self.econ["signups"] * 24 / max(1, self.econ["hours"])
        avg = sum(self.sp[h] * (s_alt if self.win[h] else s_std) for h in range(24))
        return ours / max(0.01, avg)

    def evaluate(self, std, alt=None, cut_rival=False, signups_on=True, growth=None, half_life=None, sens=1.0):
        alt = clamp_alt(alt if alt is not None else self.cur_alt, std)
        (s_std, r_std), (s_alt, r_alt) = self.shares(std, alt, cut_rival, sens)
        market_day = self.market_signups_per_day()
        on = 1.0 if signups_on else 0.0
        by_hour = [market_day * self.sp[h] * (s_alt if self.win[h] else s_std) * on for h in range(24)]
        ratio = [charge_ratio(self.econ, self.cur_alt if self.win[h] else self.cur_std, alt if self.win[h] else std)
                 for h in range(24)]
        rev_std = signup_inputs(self.econ, std)["revenue"]
        rev_alt = signup_inputs(self.econ, alt)["revenue"]
        revenue = [rev_alt if self.win[h] else rev_std for h in range(24)]
        r = project(self.econ, self.market["cash_total"], self.now, self.end, self.settings, by_hour, ratio, revenue,
                    renewal_ratio(self.econ, std), self.growth if growth is None else growth,
                    self.half_life if half_life is None else half_life, self.churn["extensions"],
                    self.churn["accounts"], self.cloud, self.usage_profile)
        share = sum(self.sp[h] * (s_alt if self.win[h] else s_std) for h in range(24))
        rival_share = sum(self.sp[h] * (r_alt if self.win[h] else r_std) for h in range(24))
        days = (self.end - self.now).total_seconds() / 86400
        ours_lb = self.market["providers"][self.us]["extensions"]
        r.update(share=share, share_std=s_std, share_alt=s_alt, signups_per_day=sum(by_hour),
                 lb_end=r["ext_end"] * self.lb_factor, lb_gain=r["ext_end"] * self.lb_factor - ours_lb)
        if self.rival_rate is not None:
            (now_s, now_r), _ = self.shares(self.cur_std, self.cur_alt)
            rr = self.rival_rate * (rival_share / now_r if now_r else 1.0)
            r["rival_end"] = self.market["providers"][self.rival]["extensions"] + rr * days
        return r


def floor_at(settings, t):
    return settings["floor_final"] if t >= settings["floor_final_from"] else settings["floor"]


def safe(result, settings):
    """Cash never below the floor in force at that time."""
    return all(c >= floor_at(settings, t) for t, c in result["points"])


def first_below_floor(result, settings):
    return next((t for t, c in result["points"] if c < floor_at(settings, t)), None)


WINDOW_OPTIONS = {
    # name -> how the alternate list follows a given standard list
    "keep the night prices": lambda cur_alt, std: dict(cur_alt),
    "night prices without per-minute cuts": lambda cur_alt, std: dict(cur_alt, **{PER_MIN[c]: std[PER_MIN[c]] for c in PER_MIN}),
    "no night prices": lambda cur_alt, std: dict(std),
}


def search_prices(ctx):
    """For each night-window option, a coordinate search over our STANDARD list; then the best.
    Rules: never above the rival on any price line, never fewer included extensions/minutes; price
    candidates: the rival's price, 1-2 steps under it, the current price and the minimum allowed;
    included quantities: current, the rival's, the current night list's. A plan is acceptable if
    cash stays above the floor even when the rival cuts every line by settings.rival_cut (and with
    the growth trend as measured). Among acceptable plans: most leaderboard extensions on the end
    date; within 1 %, more cash left (never lower than needed). If none is acceptable: highest
    lowest-cash."""
    s, cur, cur_alt = ctx.settings, ctx.cur_std, ctx.cur_alt
    rp = ctx.market["providers"][ctx.rival]["prices"]
    mins = s.get("min_prices", {})

    def score(p, follow):
        alt = follow(cur_alt, p)
        return ctx.evaluate(p, alt), ctx.evaluate(p, alt, cut_rival=True)

    def better(a, c):  # (prices, base, stress)
        sa, sc = safe(a[2], s), safe(c[2], s)
        if sa != sc:
            return sa
        if not sa:
            return a[2]["low"] > c[2]["low"]
        if abs(a[1]["lb_end"] - c[1]["lb_end"]) <= 0.01 * max(1.0, c[1]["lb_end"]):
            return a[1]["final"] > c[1]["final"]
        return a[1]["lb_end"] > c[1]["lb_end"]

    def candidates(line):
        if line in INCLUDED:
            return {cur[line], rp[line], cur_alt.get(line, cur[line])}, (lambda c: c >= rp[line])
        step = LINES[line]
        lo = mins.get(line, step)
        return {cur[line], rp[line], rp[line] - step, rp[line] - 2 * step, lo}, (lambda c: lo <= c <= rp[line])

    def search(follow):
        best = (cur, *score(cur, follow))
        for _ in range(2):
            for line in list(LINES) + list(INCLUDED):
                if line not in rp or line not in cur:
                    continue
                cands, ok = candidates(line)
                for c in sorted(cands):
                    c = round(c, 6)
                    if not ok(c) or c == best[0][line]:
                        continue
                    p = dict(best[0], **{line: c})
                    cand = (p, *score(p, follow))
                    if better(cand, best):
                        best = cand
        return best

    names = list(WINDOW_OPTIONS) if s.get("alt_window") else ["no night prices"]
    options, winner = {}, None
    for name in names:
        follow = WINDOW_OPTIONS[name]
        best = search(follow)
        options[name] = {"prices": best[0], "alt": clamp_alt(follow(cur_alt, best[0]), best[0]),
                         "base": best[1], "stress": best[2], "safe": safe(best[2], s),
                         "changes": {k: (cur[k], best[0][k]) for k in cur if k in best[0] and cur[k] != best[0][k]}}
        if winner is None or better(best, winner[1]):
            winner = (name, best)
    w = options[winner[0]]
    return dict(w, option=winner[0], options=options)


def impact(ctx, std, alt, changes):
    """Each change's share of the result: the plan without that one change (others kept)."""
    full = ctx.evaluate(std, alt)
    out = {}
    for k, (old, _) in changes.items():
        p = dict(std, **{k: old})
        r = ctx.evaluate(p, clamp_alt(alt, p))
        out[k] = {"cash": full["final"] - r["final"], "ext": full["lb_end"] - r["lb_end"]}
    return out


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
def actual_net(e, cloud_per_day=0.0):
    """What really happened to cash in a period: payments in, minus card fees, calls, numbers, VMs."""
    return (e["cash_in"] - e["card_fees"] - e["usage_cost"] - e["did_new"]
            - (e["did_renewals_per_day"] + cloud_per_day) * e["hours"] / 24)


def backtest(snapshots, settings, growth=0.0, half_life=2.0):
    """Run the model on the day before the last (with the signups that really happened, hour by
    hour, at the prices that applied) and compare with the last day. Returns
    {name: (forecast, actual, error %)} or None without 48 h."""
    days = day_windows(snapshots, 2)
    if len(days) < 2:
        return None
    e1, e2 = economics(days[0]), economics(days[1])
    by_hour = [0.0] * 24
    for snap in days[1]:
        for h in snap["hourly"]:
            by_hour[ts_hour(h["hour"]).astimezone(NY).hour] += h["signups"]
    items = (e1["cash_in"] - e1["payments"].get("topup", {}).get("amount", 0)
             - e1["payments"].get("invoice", {}).get("amount", 0))
    rev = items / max(1, e1["signups"])
    start = ts_hour(days[1][0]["hourly"][0]["hour"])
    ch = churn(snapshots[:len(snapshots) - len(days[1])]) or {"extensions": 0.0, "accounts": 0.0}
    r = project(e1, 0.0, start, start + dt.timedelta(hours=24), settings, by_hour, [1.0] * 24, [rev] * 24,
                1.0, growth, half_life, ch["extensions"], ch["accounts"], 0.0, hour_profile(days[0], 1))

    def row(pred, act):
        return (pred, act, (pred - act) / abs(act) * 100 if act else float("nan"))
    t = r["totals"]
    out = {"calls cost": row(t["usage_cost"], e2["usage_cost"]),
           "calls charged": row(t["usage_charge"], e2["usage_charge"]),
           "cash in": row(t["cash_in"], e2["cash_in"]),
           "net cash": row(r["final"], actual_net(e2))}
    if e2["exact"] and e1["exact"]:
        out["active extensions"] = row(r["ext_end"], sum(e2["active_ext"].values()))
    return out
