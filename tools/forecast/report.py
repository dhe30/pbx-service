#!/usr/bin/env python3
"""Forecast tool, step 3: the report. Suggests; never changes anything.

    report.py                 collect new hours, then the full (detailed) report
    report.py --discord       also post the SHORT version to the team channel
    report.py --remind        collect new hours, then only ask for the dashboard data (the timer
                              runs this with --discord); no forecast without fresh market data

Files (all in data_dir on mon-1, never in the repository):
    snapshots.jsonl       hourly data (collect.py)
    market.json           what only the dashboard shows; filled in per report from screenshots
                          (format: tools/forecast/market.example.json)
    market-history.jsonl  every market.json so far (the signup model learns from all of them)
    settings.json         our limits and price lists (settings.example.json)
    OFF                   if present, nothing runs
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
REMINDER = """📋 Forecast due — please send these dashboard screenshots:
1. Leaderboard (Day): every provider's extensions, customers, success rate
2. Market analysis: the whole price table + the weekly bills and signup shares
3. Course Services: bank, DID provider, US vendor, international vendor and Clanode balances,
   the Loan (owed) tab, and any Clanode payments since the last report
No forecast or price advice until they arrive."""

CHECKLIST = """Need a fresh market.json (older than {age} h or missing): run report.py --remind for the list of
screenshots, fill them into {path} (format: market.example.json), then run report.py again."""


def ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_json(path):
    with open(path) as f:
        return json.load(f)


def day(d):
    return f"{d:%b} {d.day}"


def money(x):
    return f"-${-x:,.0f}" if x < 0 else f"${x:,.0f}"


def price(x):
    return f"${x:.4f}".rstrip("0").rstrip(".") if x < 0.1 else f"${x:,.2f}"


LABEL = {"plan": "Plan", "extra_extension": "Extra extension", "local_number": "Local number",
         "toll_free_number": "Toll-free number", "recording": "Call recording", "intl_calling": "International calling",
         "us_per_min": "US calls (per min)", "uk_per_min": "International calls (per min)",
         "tf_in_per_min": "Incoming toll-free (per min)", "included_extensions": "Included extensions",
         "included_us_minutes": "Included US minutes"}


def build(cfg):
    d = cfg["data_dir"]
    snaps = [json.loads(l) for l in open(os.path.join(d, "snapshots.jsonl")) if l.strip()]
    sp = os.path.join(d, "settings.json")
    settings = load_json(sp) if os.path.exists(sp) else {}
    for k in ("end", "floor_final_from"):
        if k in settings:
            settings[k] = ts(settings[k])
    settings["_hour_profile"] = model.hour_profile(snaps)
    settings["_signup_profile"] = model.signup_hour_profile(snaps)
    settings["_data_dir"] = d
    market_path = os.path.join(d, "market.json")
    market = load_json(market_path) if os.path.exists(market_path) else None
    return snaps, settings, market, market_path


def market_history(settings, market):
    """Every market snapshot so far (market-history.jsonl), plus this one, appended if new."""
    path = os.path.join(settings["_data_dir"], "market-history.jsonl")
    hist = [json.loads(l) for l in open(path) if l.strip()] if os.path.exists(path) else []
    if not any(h.get("taken_at") == market["taken_at"] for h in hist):
        with open(path, "a") as f:
            f.write(json.dumps({k: v for k, v in market.items() if k != "cash_total"}, separators=(",", ":")) + "\n")
        hist.append(market)
    return hist


def analyse(snaps, settings, market, now):
    """Everything both outputs need."""
    a = {"econ": model.economics(model.last_hours(snaps, 24))}
    b = market["bank"]
    a["vendors"] = b.get("did", 0) + b.get("us_vendor", 0) + b.get("intl_vendor", 0)
    market["cash_total"] = b["bank"] + a["vendors"] + b.get("cloud", 0) - b.get("loan_owed", 0)
    a["history"] = history = market_history(settings, market)
    a["cloud"], a["cloud_src"] = model.cloud_cost_per_day(history, settings.get("cloud_cost_per_day", 0.0))
    settings["_cloud_per_day"] = a["cloud"]
    a["churn"] = model.churn(snaps)
    a["trend"] = model.usage_trend(snaps, settings.get("growth_half_life_days", 2.0))
    a["backtest"] = model.backtest(snaps, settings, 0.0, a["trend"][1])
    days = model.day_windows(snaps, 3)
    if len(days) >= 3:      # the trend as it was measured a day earlier, tested on the last day
        older = [s for d in days[:2] for s in d]
        g0, hl0, _ = model.usage_trend(older, settings.get("growth_half_life_days", 2.0))
        a["backtest_trend"] = (g0, model.backtest(snaps, settings, g0, hl0))
    fits = model.fit_dashboard_profiles(market, model.shape_from_snapshots(model.last_hours(snaps, 24)))
    a["fits"] = fits
    profiles = {k: v[0] for k, v in fits.items()}
    a["share_fit"] = model.fit_share_model(history, profiles, a["econ"]["new_mix"])
    bfit, gfit, _ = a["share_fit"]
    ch = a["churn"] or {"extensions": settings.get("churn_per_day", 0.0), "accounts": settings.get("churn_per_day", 0.0)}
    ctx = model.Context(market, settings, a["econ"], profiles, bfit, gfit, now, settings["end"], history,
                        a["trend"][:2], ch)
    a["ctx"] = ctx
    cur, cur_alt = ctx.cur_std, ctx.cur_alt
    a["now"] = {"as now": ctx.evaluate(cur, cur_alt), "rival cuts": ctx.evaluate(cur, cur_alt, cut_rival=True),
                "no signups": ctx.evaluate(cur, cur_alt, signups_on=False),
                "flat usage": ctx.evaluate(cur, cur_alt, growth=0.0)}
    s = model.search_prices(ctx)
    a["plan"] = s
    a["impact"] = model.impact(ctx, s["prices"], s["alt"], s["changes"])
    # Ranges for the suggested plan: growth off / as measured / fading twice as slowly; customers 30 % more / less price-sensitive.
    g, hl = a["trend"][:2]
    a["range"] = {"low growth": ctx.evaluate(s["prices"], s["alt"], growth=0.0),
                  "expected": s["base"],
                  "high growth": ctx.evaluate(s["prices"], s["alt"], half_life=hl * 2 if g else hl),
                  "more price-sensitive": ctx.evaluate(s["prices"], s["alt"], sens=1.3),
                  "less price-sensitive": ctx.evaluate(s["prices"], s["alt"], sens=0.7)}
    return a


def detailed(a, settings, market):
    e, ctx, s = a["econ"], a["ctx"], a["plan"]
    out = []
    c = e["calls"]
    out.append(f"Last {e['hours']} h: signups {e['signups']}, new extensions {e['new_extensions']} "
               f"(from new accounts {e['new_extensions'] - e['upgrades_per_day'] * e['hours'] / 24:,.0f}, "
               f"upgrades {e['upgrades_per_day'] * e['hours'] / 24:,.0f}), numbers {e['numbers']['local']} local / "
               f"{e['numbers']['toll_free']} toll-free")
    out.append(f"  active accounts {sum(e['active_accounts'].values())} ({', '.join(f'{k} {v}' for k, v in e['active_accounts'].items())}), "
               f"active extensions {sum(e['active_ext'].values()):,.0f}" + ("" if e["exact"] else "  (approximate: old snapshots)"))
    out.append(f"  cash in {money(e['cash_in'])} (top-ups {money(e['payments'].get('topup', {}).get('amount', 0))}), "
               f"card fees {money(e['card_fees'])}, credit held {money(e['state'].get('credit_held', 0))}")
    for cls in ("us", "tf_in", "intl"):
        if cls in c:
            out.append(f"  {cls:6} {c[cls]['billed_min']:>10,.0f} min  cost {money(c[cls]['cost']):>8}  "
                       f"charged {money(c[cls]['charge']):>8}  margin {money(c[cls]['charge'] - c[cls]['cost']):>8}")
    out.append(f"  calls total: cost {money(e['usage_cost'])}, charged {money(e['usage_charge'])}; numbers new "
               f"{money(e['did_new'])}, renewals {money(e['did_renewals_per_day'])}/day; net cash "
               f"{money(model.actual_net(e, a['cloud']))} incl. VMs")
    for size in model.SIZES:
        pe = e["per_ext"][size]
        out.append(f"  per active {size} extension/day: cost ${sum(pe[k]['cost'] for k in pe):.3f}, "
                   f"charged ${sum(pe[k]['charge'] for k in pe):.3f}; a new {size} account brings "
                   f"{e['ext_per_new'][size]:.1f} ext (mix {e['new_mix'][size] * 100:.0f} %)")
    ch = a["churn"]
    out.append("  churn: " + (f"{ch['gone']} accounts left in a day = {ch['accounts'] * 100:.1f} %/day of accounts, "
                              f"{ch['extensions'] * 100:.1f} %/day of extensions" if ch else "needs 48 h of new snapshots"))
    g, hl, note = a["trend"]
    out.append(f"  usage per extension grew {g * 100:+.0f} %/day; fades with half-life {hl:.1f} days ({note})")
    b = market["bank"]
    out.append(f"Cash: bank {money(b['bank'])} + vendors {money(a['vendors'])} + cloud {money(b.get('cloud', 0))} - loan "
               f"{money(b.get('loan_owed', 0))} = {money(market['cash_total'])} (dashboard {market['taken_at']}); "
               f"VMs {money(a['cloud'])}/day ({a['cloud_src']})")
    out.append(f"Leaderboard check: dashboard {market['providers'][settings['us']]['extensions']:,} extensions vs our active "
               f"{sum(e['active_ext'].values()):,.0f} (factor {ctx.lb_factor:.2f})")
    for title, bt in (("Backtest (no trend)", a["backtest"]),
                      (f"Backtest with the trend measured a day earlier ({a['backtest_trend'][0] * 100:+.0f} %/day)"
                       if a.get("backtest_trend") else None, (a.get("backtest_trend") or (0, None))[1])):
        if title and bt:
            out.append(title + ":")
            for k, (pred, act, err) in bt.items():
                fmt = (lambda x: f"{x:,.0f}") if k == "active extensions" else money
                out.append(f"  {k:18} forecast {fmt(pred):>9}  actual {fmt(act):>9}  error {err:+.0f} %")
    if not a["backtest"]:
        out.append("Backtest: needs 48 h of snapshots")
    out.append("Dashboard's typical customers (fitted to every provider's bill):")
    for size, (p, err, avg) in a["fits"].items():
        out.append(f"  {size:5}: {p['extensions']:.0f} ext, {p['local_numbers'] + p['toll_free_numbers']:.1f} numbers, "
                   f"{p['us_min']:,.0f} US min/week; bills off by {money(err)}")
    bfit, gfit, rms = a["share_fit"]
    out.append(f"Signup model ({len(a['history'])} snapshots): share ~ bill^-{bfit:.1f} x e^({gfit:.1f} x grade), error "
               f"{rms * 100:.1f} pts; calibrated to our current share; market ~{ctx.market_signups_per_day():.0f} signups/day; "
               f"rival grows {('%.0f ext/day' % ctx.rival_rate) if ctx.rival_rate is not None else 'unknown (needs 6 h of history)'}")
    out.append(f"At current prices, to {day(settings['end'])}:")
    for name, r in a["now"].items():
        below = model.first_below_floor(r, settings)
        out.append(f"  {name:11} signups/day {r['signups_per_day']:4.0f}  lowest {money(r['low']):>8}  end {money(r['final']):>8}  "
                   f"leaderboard ext {r['lb_end']:,.0f}" + (f"  below floor {below:%b %d %H:00}" if below else ""))
    out.append("Night-window options (each with its best standard list):")
    for name, o in s["options"].items():
        out.append(f"  {name:38} share day/night {o['base']['share_std'] * 100:3.0f}/{o['base']['share_alt'] * 100:3.0f} %  "
                   f"ext {o['base']['lb_end']:,.0f}  cash end {money(o['base']['final']):>8}  rival cuts low "
                   f"{money(o['stress']['low']):>8}" + ("" if o["safe"] else " NOT SAFE") + ("  <-- best" if name == s["option"] else ""))
    out.append(f"Suggested ({s['option']}): " + ("" if s["safe"] else "NOT safe if the rival cuts; safest found"))
    for k, (old, new) in s["changes"].items():
        im = a["impact"].get(k, {})
        out.append(f"  {LABEL.get(k, k):30} {old:>9} -> {new:<9} (rival {market['providers'][settings['rival']]['prices'].get(k)})  "
                   f"effect: cash {money(im.get('cash', 0)):>7}, ext {im.get('ext', 0):+,.0f}")
    out.append("Ranges for the suggested plan (cash end / lowest / leaderboard ext):")
    for name, r in a["range"].items():
        out.append(f"  {name:14} {money(r['final']):>8} / {money(r['low']):>8} / {r['lb_end']:,.0f}")
    return out


def short(a, settings, market):
    """The Discord post: plain language, only what matters."""
    e, s = a["econ"], a["plan"]
    rival, us = settings["rival"], settings["us"]
    now_r = a["now"]["as now"]
    taken = ts(market["taken_at"]).astimezone(model.NY)
    nowny = dt.datetime.now(model.NY)
    tf = e["calls"].get("tf_in", {})
    lines = [f"📊 Forecast — {day(nowny)}, {nowny:%-I:%M %p} (dashboard data from {taken:%-I:%M %p})", ""]
    lines.append(f"Cash now: {money(market['cash_total'])}  (bank {money(market['bank']['bank'])} · vendors "
                 f"{money(a['vendors'])} · cloud {money(market['bank'].get('cloud', 0))})")
    lines.append(f"Last 24 h: +{e['signups']} customers, +{e['new_extensions']:,} extensions, "
                 f"net cash {money(model.actual_net(e, a['cloud']))}")
    loss = e["usage_charge"] - e["usage_cost"]
    if loss < 0:
        lines.append(f"Calls lost {money(-loss)}" + (f" — mostly incoming toll-free ({money(tf['charge'] - tf['cost'])})"
                                                     if tf and tf["charge"] - tf["cost"] < 0.6 * loss else ""))
    below = model.first_below_floor(now_r, settings)
    lines.append("")
    lines.append(f"⚠️ At current prices, cash drops below {money(model.floor_at(settings, below))} around {day(below)}"
                 if below else f"✅ At current prices, cash stays above the floor through {day(settings['end'])}")
    if s["changes"] or s["option"] != "keep the night prices":
        lines += ["", "✅ Recommended"]
        ranked = sorted(s["changes"].items(), key=lambda kv: -abs(a["impact"].get(kv[0], {}).get("cash", 0)))
        major = [(k, v) for k, v in ranked if abs(a["impact"].get(k, {}).get("cash", 0)) >= 100][:3]
        minor = [k for k, _ in ranked if (k, s["changes"][k]) not in major]
        rp = market["providers"][rival]["prices"]
        for k, (old, new) in major:
            note = "same as rival" if new == rp.get(k) else f"rival {price(rp[k])}" if k in rp and k not in model.INCLUDED else ""
            val = (lambda x: f"{x:,.0f}") if k in model.INCLUDED else price
            lines.append(f"• {LABEL.get(k, k)}: {val(old)} → {val(new)}" + (f"  ({note})" if note else ""))
        if s["option"] != "keep the night prices" and settings.get("alt_window"):
            lines.append("• Night prices: " + ("stop the per-minute discounts" if "per-minute" in s["option"]
                                               else "use the same prices day and night"))
        if minor:
            lines.append("  (minor: " + ", ".join(f"{LABEL.get(k, k).lower()} {price(s['changes'][k][1]) if k not in model.INCLUDED else s['changes'][k][1]}"
                                                  for k in minor) + ")")
    r = s["base"]
    lines.append("")
    lines.append(f"With that: cash on {day(settings['end'])} ≈ {money(r['final'])}"
                 + (f", still above the floor if the rival cuts {settings['rival_cut'] * 100:.0f} %" if s["safe"]
                    else " — NOT safe if the rival cuts prices"))
    lo, hi = a["range"]["low growth"]["final"], a["range"]["high growth"]["final"]
    lines.append(f"  (range {money(min(lo, hi))} to {money(max(lo, hi))} depending on how call volume grows)")
    gap_now = market["providers"][rival]["extensions"] - market["providers"][us]["extensions"]
    line = f"Signups ~{r['share'] * 100:.0f} % · leaderboard ~{r['lb_end']:,.0f} extensions by {day(settings['end'])}"
    if "rival_end" in r:
        gap_end = r["rival_end"] - r["lb_end"]
        line += f" vs rival ~{r['rival_end']:,.0f}" + (" (we lead)" if gap_end < 0 else "")
    lines.append(line)
    lines.append(f"Gap to #1 now: {gap_now:,} extensions")
    bt = a.get("backtest_trend")
    conf = "money ✓" if bt and bt[1] and abs(bt[1]["calls cost"][2]) <= 10 else "money ~ (few days of data)"
    lines.append("")
    lines.append(f"Confidence: {conf} · signup estimate rough (±{a['share_fit'][2] * 100:.0f} pts)")
    return lines


def post_discord(url, lines, code=False):
    text = "\n".join(lines)
    for i in range(0, len(text), 1900):     # Discord's limit is 2000 characters per message
        chunk = text[i:i + 1900]
        body = json.dumps({"content": "```\n" + chunk + "\n```" if code else chunk}).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json",
                                                              "User-Agent": "pbx-forecast"})
        urllib.request.urlopen(req, timeout=10).read()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default="/etc/pbx-forecast/config.json")
    ap.add_argument("--discord", action="store_true")
    ap.add_argument("--remind", action="store_true")
    ap.add_argument("--no-collect", action="store_true")
    args = ap.parse_args()
    cfg = load_json(args.config)
    if os.path.exists(os.path.join(cfg["data_dir"], "OFF")):
        print("report: OFF file present, doing nothing")
        return 0
    if not args.no_collect:
        subprocess.run([sys.executable, os.path.join(HERE, "collect.py"), "--config", args.config], check=True)
    if args.remind:
        print(REMINDER)
        if args.discord and cfg.get("discord_webhook"):
            post_discord(cfg["discord_webhook"], REMINDER.splitlines())
        return 0
    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    snaps, settings, market, market_path = build(cfg)
    if not settings:
        print(f"report: no settings.json in {cfg['data_dir']} (format: settings.example.json)")
        return 1
    max_age = settings.get("max_market_age_hours", 3)
    if not market or now - ts(market["taken_at"]) > dt.timedelta(hours=max_age):
        print(CHECKLIST.format(age=max_age, path=market_path))
        return 1
    a = analyse(snaps, settings, market, now)
    print("\n".join(detailed(a, settings, market)))
    s = short(a, settings, market)
    print("\n---- Discord version ----\n" + "\n".join(s))
    if args.discord and cfg.get("discord_webhook"):
        post_discord(cfg["discord_webhook"], s)
    return 0


if __name__ == "__main__":
    sys.exit(main())
