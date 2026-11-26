"""Forecast tool, step 2: the model. Pure functions, stdlib only, unit-tested (test_model.py).

Inputs
  snapshots  hourly JSON snapshots of our own data (collect.py)
  market     what only the course dashboard shows, entered per report (market.example.json):
             bank and vendor balances, every provider's price list, weekly bill estimates,
             share of new signups and reputation grade
  settings   our own limits (settings.example.json): cash floor, end date, how far a rival may cut

Outputs (report.py prints them)
  economics  last 24 h: cash in / out by kind, usage margin by call type
  bills      every provider's weekly bill recomputed from its prices, checked against the dashboard
  shares     a signup-share model fitted to the dashboard: share ~ exp(-b * ln(bill) + g * grade)
  cash       hour-by-hour cash forecast to the end date, for: as now / a rival cuts / no signups
  prices     the price list that gains the most extensions by the end date while the
             "rival cuts" case keeps cash above the floor
"""
import datetime as dt
import math

GRADES = {"A": 4, "B": 3, "C": 2, "D": 1, "F": 0}
CARD_PCT, CARD_FIXED, MIN_CHARGE = 0.029, 0.30, 0.50
# What the DID provider charges us per number: first period (setup + 7 days), then per 7 days.
DID_FIRST = {"local": 1.50, "toll_free": 5.00}
DID_WEEK = {"local": 1.50, "toll_free": 3.00}

# Price lines as the dashboard lists them. "step" = the smallest change worth making on that line.
LINES = {
    "plan": 0.01, "extra_extension": 0.01, "local_number": 0.01, "toll_free_number": 0.01,
    "recording": 0.01, "intl_calling": 0.01, "us_per_min": 0.0001, "uk_per_min": 0.001,
    "tf_in_per_min": 0.001,
}


# ---------------------------------------------------------------- our own data (snapshots) ----
def window(snapshots, hours):
    """The last `hours` hourly snapshots."""
    return snapshots[-hours:]


def economics(snapshots, hours=24):
    """Sums of the hourly data over the last `hours`."""
    w = window(snapshots, hours)
    calls, pay = {}, {}
    out = {"hours": len(w), "signups": 0, "new_extensions": 0, "numbers": {"local": 0, "toll_free": 0},
           "failed_payments": 0}
    for s in w:
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
    out["calls"], out["payments"] = calls, pay
    out["usage_cost"] = sum(c["cost"] for c in calls.values())
    out["usage_charge"] = sum(c["charge"] for c in calls.values())
    out["cash_in"] = sum(p["amount"] for p in pay.values())
    out["card_fees"] = sum(p["n"] * CARD_FIXED + p["amount"] * CARD_PCT for p in pay.values())
    out["did_new"] = sum(out["numbers"][k] * DID_FIRST[k] for k in DID_FIRST)
    st = w[-1]["state"] if w else {}
    items = st.get("renewing_items") or {}
    out["did_renewals_per_day"] = sum(items.get(f"number_{k}", {}).get("active", 0) * DID_WEEK[k] for k in DID_WEEK) / 7
    out["state"] = st
    return out


def hour_profile(snapshots, days=3):
    """Share of a day's usage cost that falls in each New York hour (0-23), from recent history."""
    ny = dt.timezone(dt.timedelta(hours=-5))   # course runs in EST (no DST in late Nov / Dec)
    tot = [0.0] * 24
    for s in window(snapshots, days * 24):
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
    profile: extensions, local_numbers, toll_free_numbers, recording (0/1), intl (0/1),
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


def fit_profile_scale(market, size, profile):
    """Scale the minutes of a profile so the recomputed bills best match the dashboard's for one
    size (least squares over providers, scale in [0, 20]). Returns (scale, mean abs error $)."""
    best = (1.0, float("inf"))
    for i in range(0, 2001):
        k = i / 100
        prof = dict(profile, us_min=profile["us_min"] * k, uk_min=profile.get("uk_min", 0) * k,
                    tf_in_min=profile.get("tf_in_min", 0) * k)
        errs = [abs(weekly_bill(p["prices"], prof) - p["bills"][size])
                for p in market["providers"].values() if p.get("bills", {}).get(size) is not None]
        if errs:
            e = sum(errs) / len(errs)
            if e < best[1]:
                best = (k, e)
    return best


# -------------------------------------------------------------------------------- shares ----
def blended_bill(prices, profiles, mix):
    """Bill weighted by the mix of new customers' sizes."""
    return sum(mix[s] * weekly_bill(prices, profiles[s]) for s in mix)


def fit_share_model(market, profiles, mix):
    """Fit share_i ~ exp(-b * ln(bill_i) + g * grade_i) to the dashboard's signup shares (providers
    with a share > 0). Grid search over b in [0, 10], g in [0, 3]. Returns (b, g, rms error)."""
    rows = []
    for p in market["providers"].values():
        if p.get("signup_share", 0) > 0:
            rows.append((math.log(max(0.01, blended_bill(p["prices"], profiles, mix))),
                         GRADES[p["reputation"]], p["signup_share"]))
    best = (1.0, 0.5, float("inf"))
    if len(rows) < 2:
        return best
    tot = sum(r[2] for r in rows)
    for bi in range(0, 101):
        b = bi / 10
        for gi in range(0, 31):
            g = gi / 10
            w = [math.exp(-b * lb + g * gr) for lb, gr, _ in rows]
            sw = sum(w)
            err = math.sqrt(sum((wi / sw - s / tot) ** 2 for wi, (_, _, s) in zip(w, rows)) / len(rows))
            if err < best[2]:
                best = (b, g, err)
    return best


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
def project_cash(start_cash, econ, profile_by_hour, end, now, signups_per_day, ext_per_signup,
                 numbers_per_signup, revenue_per_signup, first_topup_per_signup, usage_growth_per_day):
    """Hour-by-hour cash until `end`. Returns (list of (time, cash), minimum cash, final cash).

    Cash model (prepaid): top-ups refill what calls used up (cash in = usage charged) plus each new
    account's first top-up; vendors cost what calls cost; numbers cost the DID provider; every card
    charge pays 2.9 % + $0.30. Usage scales with the extension base, which grows with signups.
    """
    h = econ["hours"] or 24
    usage_cost_day = econ["usage_cost"] * 24 / h
    usage_charge_day = econ["usage_charge"] * 24 / h
    refills_per_day = econ["payments"].get("topup", {}).get("n", 0) * 24 / h
    did_renew_day = econ["did_renewals_per_day"]
    base_ext = max(1, econ["state"].get("extensions", 1))
    numbers_n = sum(numbers_per_signup.values())
    did_per_signup = sum(numbers_per_signup[k] * DID_FIRST[k] for k in DID_FIRST)
    su = signups_per_day / 24                                   # new accounts per hour
    ext, cash, t, pts, low = float(base_ext), start_cash, now, [], start_cash
    while t < end:
        days = (t - now).total_seconds() / 86400
        scale = ext / base_ext * (1 + usage_growth_per_day) ** days   # usage follows the extension base
        frac = profile_by_hour[(t.hour - 5) % 24]                     # this New York hour's share of a day
        cash_in = usage_charge_day * scale * frac + su * (first_topup_per_signup + revenue_per_signup)
        charges = refills_per_day * scale * frac + su * (1 + numbers_n)  # card charges this hour
        fees = charges * CARD_FIXED + cash_in * CARD_PCT
        cost = usage_cost_day * scale * frac + su * did_per_signup + did_renew_day * scale / 24
        cash += cash_in - fees - cost
        low = min(low, cash)
        pts.append((t, cash))
        ext += su * ext_per_signup
        t += dt.timedelta(hours=1)
    return pts, low, cash


# ------------------------------------------------------------------------- what-if inputs ----
def first_charge(price, prorate=0.9):
    """What a new customer pays for an item on signup: prorated, waived under the minimum charge."""
    amount = price * prorate
    return amount if amount >= MIN_CHARGE else 0.0


def signup_inputs(econ, our_prices):
    """Per-signup averages from the last day, at our current (or proposed) prices."""
    n = max(1, econ["signups"])
    nums = {k: econ["numbers"][k] / n for k in ("local", "toll_free")}
    topup = econ["payments"].get("topup", {}).get("amount", 0.0)
    revenue = (first_charge(our_prices["plan"]) + nums["local"] * first_charge(our_prices["local_number"])
               + nums["toll_free"] * first_charge(our_prices["toll_free_number"]))
    return {
        "ext_per_signup": econ["new_extensions"] / n,
        "numbers_per_signup": nums,
        "revenue_per_signup": revenue,
        # Top-ups beyond refilling what calls used = new accounts' first top-ups.
        "first_topup_per_signup": max(0.0, topup - econ["usage_charge"]) / n,
    }


def reprice_usage(econ, old, new):
    """econ with call charges recomputed for new per-minute prices (same minutes)."""
    out = dict(econ)
    ratio = {"us": "us_per_min", "tf_in": "tf_in_per_min", "intl": "uk_per_min"}
    charge = 0.0
    for cls, c in econ["calls"].items():
        k = ratio.get(cls)
        r = new[k] / old[k] if k and old.get(k) else 1.0
        charge += c["charge"] * r
    out["usage_charge"] = charge
    return out


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
    e2 = reprice_usage(econ, market["providers"][us]["prices"], ours)
    si = signup_inputs(econ, ours)
    pts, low, final = project_cash(market["cash_total"], e2, hour_profile_cached(settings), end, now, spd,
                                   si["ext_per_signup"], si["numbers_per_signup"], si["revenue_per_signup"],
                                   si["first_topup_per_signup"], settings.get("usage_growth_per_day", 0.0))
    days = (end - now).total_seconds() / 86400
    return {"share": share, "signups_per_day": spd, "ext_gain": spd * si["ext_per_signup"] * days,
            "low": low, "final": final, "points": pts}


def hour_profile_cached(settings):
    return settings.get("_hour_profile") or [1 / 24] * 24


def floor_at(settings, t):
    return settings["floor_final"] if t >= settings["floor_final_from"] else settings["floor"]


def safe(result, settings):
    """Cash never below the floor in force at that time."""
    return all(c >= floor_at(settings, t) for t, c in result["points"])


def search_prices(market, settings, econ, profiles, mix, b, g, now, end):
    """Coordinate search over our price lines. Rules: never above the rival on any line; candidates
    are the rival's price and 1-2 steps under it, the current price, and the minimum allowed. A
    price list is acceptable only if cash stays above the floor even when the rival cuts every line
    by settings['rival_cut']. Among acceptable lists: most extensions gained; when two are within
    1 %, the cheaper-to-run one (higher prices) wins, so we never go lower than needed."""
    us, rival = settings["us"], settings["rival"]
    cur = dict(market["providers"][us]["prices"])
    rp = market["providers"][rival]["prices"]
    mins = settings.get("min_prices", {})

    def score(p):
        stress = evaluate(market, settings, econ, profiles, mix, b, g, p, now, end, cut_rival=True)
        base = evaluate(market, settings, econ, profiles, mix, b, g, p, now, end)
        return base, stress

    def better(a, b_):  # a, b_ = (prices, base, stress)
        ok_a, ok_b = safe(a[2], settings), safe(b_[2], settings)
        if ok_a != ok_b:
            return ok_a
        if abs(a[1]["ext_gain"] - b_[1]["ext_gain"]) <= 0.01 * max(1.0, b_[1]["ext_gain"]):
            return a[1]["final"] > b_[1]["final"]
        return a[1]["ext_gain"] > b_[1]["ext_gain"]

    best = (cur, *score(cur))
    for _ in range(2):                       # two passes are enough for these few lines
        for line, step in LINES.items():
            if line not in rp or line not in cur:
                continue
            cands = {cur[line], rp[line], rp[line] - step, rp[line] - 2 * step, mins.get(line, step)}
            for c in sorted(cands):
                c = round(c, 6)
                if c > rp[line] or c < mins.get(line, step) or c == best[0][line]:
                    continue
                p = dict(best[0], **{line: c})
                cand = (p, *score(p))
                if better(cand, best):
                    best = cand
    return {"prices": best[0], "base": best[1], "stress": best[2], "safe": safe(best[2], settings),
            "changes": {k: (cur[k], best[0][k]) for k in cur if cur[k] != best[0][k]}}


# ------------------------------------------------------------------------ customer profiles ----
def profiles_from_snapshots(snapshots, hours=24):
    """A typical account of each size, per week: extensions, numbers, add-ons, minutes by call type
    (international minutes stand in for the dashboard's UK line). Also the size mix of accounts."""
    w = window(snapshots, hours)
    st = w[-1]["state"]["by_size"]
    mins = {s: {"us": 0.0, "tf_in": 0.0, "intl": 0.0} for s in st}
    for snap in w:
        for s, v in snap["state"]["by_size"].items():
            for cls in ("us", "tf_in", "intl"):
                mins.setdefault(s, {"us": 0.0, "tf_in": 0.0, "intl": 0.0})[cls] += v["usage_in_window"].get(cls, {}).get("min", 0.0)
    scale = 7 * 24 / max(1, len(w))
    profiles, total = {}, sum(v["accounts"] for v in st.values()) or 1
    for s, v in st.items():
        n = max(1, v["accounts"])
        profiles[s] = {
            "extensions": v["extensions"] / n,
            "local_numbers": v["local_numbers"] / n, "toll_free_numbers": v["toll_free_numbers"] / n,
            "recording": v["recording"] / n, "intl": v["intl_calling"] / n,
            "us_min": mins[s]["us"] * scale / n, "tf_in_min": mins[s]["tf_in"] * scale / n,
            "uk_min": mins[s]["intl"] * scale / n,
        }
    mix = {s: v["accounts"] / total for s, v in st.items()}
    return profiles, mix
