#!/usr/bin/env python3
"""Forecast tool, step 3: the report. Suggests; never changes anything.

    report.py                 collect new hours, then a full report (needs a fresh market.json)
    report.py --summary       short summary from our own data + the last market.json (timer, Discord)
    report.py --discord       also post the result to the team channel (webhook in config.json)

Files (all in data_dir on mon-1, never in the repository):
    snapshots.jsonl   hourly data (collect.py)
    market.json       what only the dashboard shows; filled in per report from screenshots
                      (format: tools/forecast/market.example.json)
    settings.json     our limits: floor, end date, rival, rival cut (settings.example.json)
    OFF               if present, nothing runs
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.request

import model

HERE = os.path.dirname(os.path.abspath(__file__))
CHECKLIST = """Need a fresh market.json (older than {age} h or missing). From the course dashboard:
  1. Leaderboard: every provider's extensions, customers, success rate
  2. Market analysis: every provider's price lines, weekly bills (small / mid / large),
     signup share, reputation grade, signup fee
  3. Course Services -> Activity: bank balance, and the DID provider, US vendor, international
     vendor and loan tabs' balances
Fill them into {path} (format: market.example.json), then run report.py again."""


def ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_json(path):
    with open(path) as f:
        return json.load(f)


def money(x):
    return f"-${-x:,.0f}" if x < 0 else f"${x:,.0f}"


def build(cfg, now):
    d = cfg["data_dir"]
    snaps = [json.loads(l) for l in open(os.path.join(d, "snapshots.jsonl")) if l.strip()]
    sp = os.path.join(d, "settings.json")
    settings = load_json(sp) if os.path.exists(sp) else {}     # only the full report needs it
    for k in ("end", "floor_final_from"):
        if k in settings:
            settings[k] = ts(settings[k])
    settings["_hour_profile"] = model.hour_profile(snaps)
    settings["_data_dir"] = d
    market_path = os.path.join(d, "market.json")
    market = load_json(market_path) if os.path.exists(market_path) else None
    return snaps, settings, market, market_path


def our_economics_text(econ):
    c = econ["calls"]
    lines = [f"Last {econ['hours']} h (our data): signups {econ['signups']}, new extensions {econ['new_extensions']}, "
             f"numbers {econ['numbers']['local']} local / {econ['numbers']['toll_free']} toll-free"]
    lines.append(f"  cash in {money(econ['cash_in'])} (top-ups {money(econ['payments'].get('topup', {}).get('amount', 0))}), "
                 f"card fees {money(econ['card_fees'])}")
    lines.append(f"  calls: cost {money(econ['usage_cost'])}, charged {money(econ['usage_charge'])}, "
                 f"margin {money(econ['usage_charge'] - econ['usage_cost'])}")
    for cls in ("us", "tf_in", "intl"):
        if cls in c:
            lines.append(f"    {cls:6} {c[cls]['billed_min']:>10,.0f} min  cost {money(c[cls]['cost']):>8}  "
                         f"charged {money(c[cls]['charge']):>8}  margin {money(c[cls]['charge'] - c[cls]['cost']):>8}")
    lines.append(f"  numbers: new {money(econ['did_new'])}, renewals ~{money(econ['did_renewals_per_day'])}/day; "
                 f"prepaid credit held {money(econ['state'].get('credit_held', 0))}")
    real = (econ["usage_charge"] + econ["cash_in"] - econ["payments"].get("topup", {}).get("amount", 0)
            - econ["usage_cost"] - econ["card_fees"] - econ["did_new"] - econ["did_renewals_per_day"] * econ["hours"] / 24)
    lines.append(f"  earned minus spent (credit used, not top-ups): {money(real)}")
    return lines


def market_history(settings, market):
    """Every market snapshot so far (market-history.jsonl in the data dir), plus this one; this one
    is appended if it is new. The signup model is fitted to all of them."""
    path = os.path.join(settings["_data_dir"], "market-history.jsonl")
    hist = [json.loads(l) for l in open(path) if l.strip()] if os.path.exists(path) else []
    if not any(h.get("taken_at") == market["taken_at"] for h in hist):
        with open(path, "a") as f:
            f.write(json.dumps({k: v for k, v in market.items() if k != "cash_total"}, separators=(",", ":")) + "\n")
        hist.append(market)
    return hist


def full_report(snaps, settings, market, now):
    recent = model.last_hours(snaps, 24)
    econ = model.economics(recent)
    out = our_economics_text(econ)
    if econ["hours"] < 24:
        out.append(f"  (only {econ['hours']} h of data: daily figures are scaled up from them)")
    us, rival = settings["us"], settings["rival"]
    b = market["bank"]
    market["cash_total"] = b["bank"] + b.get("did", 0) + b.get("us_vendor", 0) + b.get("intl_vendor", 0) - b.get("loan_owed", 0)
    out.append(f"Cash: bank {money(b['bank'])} + vendors {money(market['cash_total'] - b['bank'] + b.get('loan_owed', 0))}"
               f" - loan {money(b.get('loan_owed', 0))} = {money(market['cash_total'])}  (market data from {market['taken_at']})")

    bt = model.backtest(snaps, settings)
    if bt:
        g = max(-0.5, min(1.0, bt.pop("_growth_per_day")))
        settings["_growth_per_day"] = g
        out.append("Backtest (the flat model, run on the day before, vs what happened in the last 24 h):")
        for k, (pred, act, err) in bt.items():
            out.append(f"  {k:14} forecast {money(pred):>8}  actual {money(act):>8}  error {err:+.0f} %")
        out.append(f"  -> existing usage grew {g * 100:+.0f} %/day beyond new accounts; the forecast applies that "
                   f"trend, halving every {settings.get('growth_half_life_days', 2.0):g} days")
        older = snaps[:len(snaps) - len(model.last_hours(snaps, 24))]
        prev = model.backtest(older, settings) if model.hours_in(older) >= 48 else None
        if prev:
            g0 = max(-0.5, min(1.0, prev.pop("_growth_per_day")))
            bt2 = model.backtest(snaps, settings, g0)
            bt2.pop("_growth_per_day")
            out.append(f"Backtest with the trend measured the day before ({g0 * 100:+.0f} %/day):")
            for k, (pred, act, err) in bt2.items():
                out.append(f"  {k:14} forecast {money(pred):>8}  actual {money(act):>8}  error {err:+.0f} %")
        else:
            out.append("  (the trend itself can be backtested once there are 72 h of snapshots)")
    else:
        out.append("Backtest: needs 48 h of snapshots (no usage trend applied)")

    fits = model.fit_dashboard_profiles(market, model.shape_from_snapshots(recent))
    profiles = {k: v[0] for k, v in fits.items()}
    out.append("Dashboard's typical customer per size (fitted to every provider's bill):")
    for size, (p, err, avg) in fits.items():
        flag = "" if err <= max(1.0, 0.1 * avg) else "  <-- poor fit: treat price advice with care"
        out.append(f"  {size:5}: {p['extensions']:.0f} ext, {p['local_numbers'] + p['toll_free_numbers']:.1f} numbers, "
                   f"{p['us_min']:,.0f} US min/week; bills off by {money(err)} on average{flag}")
    mix = econ["new_mix"]
    history = market_history(settings, market)
    bfit, gfit, rms = model.fit_share_model(history, profiles, mix)
    out.append(f"Signup model ({len(history)} market snapshot(s)): share ~ bill^-{bfit:.1f} x e^({gfit:.1f} x grade), "
               f"fit error {rms * 100:.1f} pts" + ("  <-- poor fit" if rms > 0.05 else ""))

    end = settings["end"]
    cur = market["providers"][us]["prices"]
    cases = [("as now", {}), ("rival cuts", {"cut_rival": True}), ("no signups", {"signups_on": False})]
    out.append(f"Cash to {end:%b %d} at current prices (floor {money(settings['floor'])}, "
               f"{money(settings['floor_final'])} from {settings['floor_final_from']:%b %d}):")
    for name, kw in cases:
        r = model.evaluate(market, settings, econ, profiles, mix, bfit, gfit, cur, now, end, **kw)
        below = next((t for t, c in r["points"] if c < model.floor_at(settings, t)), None)
        out.append(f"  {name:11} signups/day {r['signups_per_day']:5.0f}  lowest {money(r['low']):>8}  end {money(r['final']):>8}"
                   + (f"  BELOW FLOOR from {below:%b %d %H:%M}" if below else ""))

    s = model.search_prices(market, settings, econ, profiles, mix, bfit, gfit, now, end)
    if s["safe"]:
        out.append("Suggested prices (never above the rival; smallest change that wins; cash stays above the floor "
                   f"even if the rival cuts {settings['rival_cut'] * 100:.0f} %):")
    else:
        out.append("No price list keeps cash above the floor if the rival cuts. Safest list:")
    if not s["changes"]:
        out.append("  keep current prices")
    for k, (a, bb) in s["changes"].items():
        out.append(f"  {k:18} {a:>9} -> {bb:<9} (rival {market['providers'][rival]['prices'].get(k)})")
    out.append(f"  expected: share {s['base']['share'] * 100:.0f} %, +{s['base']['ext_gain']:,.0f} extensions by {end:%b %d}, "
               f"cash end {money(s['base']['final'])} (rival cuts: lowest {money(s['stress']['low'])})")
    gap = market["providers"][rival]["extensions"] - market["providers"][us]["extensions"]
    rate = s["base"]["signups_per_day"] * model.signup_inputs(econ, s["prices"])["ext_per_signup"]
    out.append(f"Gap to the rival: {gap:,} extensions; we add ~{rate:,.0f}/day "
               "(their growth is not modelled: compare the leaderboard between reports)")
    return out


def summary(snaps, settings, market):
    out = our_economics_text(model.economics(model.last_hours(snaps, 24)))
    if market:
        out.append(f"(last market data: {market['taken_at']}; run a full report with fresh screenshots for price advice)")
    return out


def post_discord(url, lines):
    text = "\n".join(lines)
    for i in range(0, len(text), 1900):     # Discord's limit is 2000 characters per message
        body = json.dumps({"content": "```\n" + text[i:i + 1900] + "\n```"}).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default="/etc/pbx-forecast/config.json")
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--discord", action="store_true")
    ap.add_argument("--no-collect", action="store_true")
    args = ap.parse_args()
    cfg = load_json(args.config)
    if os.path.exists(os.path.join(cfg["data_dir"], "OFF")):
        print("report: OFF file present, doing nothing")
        return 0
    if not args.no_collect:
        subprocess.run([sys.executable, os.path.join(HERE, "collect.py"), "--config", args.config], check=True)
    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    snaps, settings, market, market_path = build(cfg, now)
    max_age = settings.get("max_market_age_hours", 3)
    fresh = market and now - ts(market["taken_at"]) <= dt.timedelta(hours=max_age)
    if not args.summary and not settings:
        print(f"report: no settings.json in {cfg['data_dir']} (format: settings.example.json)")
        return 1
    if args.summary or not fresh:
        lines = summary(snaps, settings, market)
        if not args.summary:
            lines.append(CHECKLIST.format(age=max_age, path=market_path))
    else:
        lines = full_report(snaps, settings, market, now)
    print("\n".join(lines))
    if args.discord and cfg.get("discord_webhook"):
        post_discord(cfg["discord_webhook"], lines)
    return 0


if __name__ == "__main__":
    sys.exit(main())
