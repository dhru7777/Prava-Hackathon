#!/usr/bin/env python3
"""
Generate coffee-shop fridge inventory (30-min snaps) + demand-driven orders.

- Open hours: 06:00–21:30 every 30 min → 32 snapshots/day
- History: last 60 days (ending 2026-08-01)
- Traffic: ~400/day weekday, ~600–700 weekend
- Coffee ~92% of visitors; 0.5 eggs/person
- Orders from runway_days (qty / 7d avg use), not a fixed calendar
- Deliveries bump inventory so history stays consistent

Output → part2_linq/data/
"""

from __future__ import annotations

import csv
import math
import random
from dataclasses import dataclass
from datetime import date, datetime, timedelta, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data"
SEED = 42
DAYS = 60
END_DATE = date(2026, 8, 1)
START_DATE = END_DATE - timedelta(days=DAYS - 1)

SLOT_MINUTES = [h * 60 + m for h in range(6, 22) for m in (0, 30) if h * 60 + m <= 21 * 60 + 30]
assert len(SLOT_MINUTES) == 32, len(SLOT_MINUTES)

TRAFFIC_SHARES = [
    0.025, 0.025,  # 06:00-07:00
    0.06, 0.08, 0.09, 0.07, 0.05,  # 07:00-09:30 rush
    0.04, 0.04, 0.035, 0.035,  # 09:30-11:30
    0.04, 0.05, 0.045, 0.035, 0.03,  # 11:30-14:00 lunch
    0.02, 0.02, 0.02, 0.02, 0.02, 0.02,  # 14:00-17:00
    0.02, 0.02, 0.015, 0.015, 0.015, 0.015,  # 17:00-20:00
    0.012, 0.01, 0.01, 0.008,  # 20:00-21:30 (4 slots)
]
assert len(TRAFFIC_SHARES) == 32, len(TRAFFIC_SHARES)
_s = sum(TRAFFIC_SHARES)
TRAFFIC_SHARES = [x / _s for x in TRAFFIC_SHARES]


@dataclass
class Sku:
    sku_id: str
    sku_name: str
    category: str
    unit: str
    par_level: float
    reorder_point_days: float
    target_cover_days: float
    pack_size: float
    unit_cost: float
    supplier: str
    lead_hours_mean: float
    lead_hours_std: float
    starting_qty: float


SKUS: list[Sku] = [
    Sku("MILK-WHOLE-1GAL", "Whole milk 1 gal", "dairy", "gallon", 6.0, 3.0, 5.5, 1.0, 4.25, "Metro Dairy Co", 28, 8, 7.0),
    Sku("MILK-2PCT-1GAL", "2% milk 1 gal", "dairy", "gallon", 4.0, 3.0, 5.0, 1.0, 3.95, "Metro Dairy Co", 28, 8, 5.0),
    Sku("MILK-OAT-1L", "Oat milk 1L", "alt-milk", "liter", 12.0, 3.5, 7.0, 2.0, 2.80, "AltBeans Supply", 56, 12, 14.0),
    Sku("EGG-LG-DZ", "Large eggs dozen", "eggs", "dozen", 20.0, 2.0, 4.5, 1.0, 5.50, "Hudson Valley Eggs", 18, 6, 22.0),
    Sku("HALFHALF-QT", "Half & half quart", "dairy", "quart", 6.0, 2.5, 5.0, 1.0, 3.10, "Metro Dairy Co", 28, 8, 7.0),
    Sku("BUTTER-UNSALT-LB", "Unsalted butter lb", "dairy", "lb", 8.0, 5.0, 10.0, 1.0, 6.40, "Pastry Provisions", 72, 18, 9.0),
]


@dataclass
class OpenOrder:
    order_id: str
    line_id: str
    sku_id: str
    order_qty: float
    unit: str
    unit_cost: float
    supplier: str
    trigger: str
    decision_ts: datetime
    placed_ts: datetime
    confirmed_ts: datetime | None
    shipped_ts: datetime | None
    delivered_ts: datetime | None
    cancelled_ts: datetime | None
    initial_status: str
    qty_on_hand_at_decision: float
    avg_daily_use_7d: float
    runway_days: float
    reorder_point_days: float
    target_cover_days: float
    visitors_trailing_7d_avg: float
    lead_time_hours: float
    notes: str
    delivered_qty: float


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def round_qty(x: float, unit: str) -> float:
    if unit == "dozen":
        return round(max(0.0, x), 1)
    return round(max(0.0, x), 2)


def is_weekend(d: date) -> bool:
    return d.weekday() >= 5


def pack_ceil(qty: float, pack: float) -> float:
    if qty <= 0:
        return pack
    return math.ceil(qty / pack) * pack


def sample_visitors(d: date, rng: random.Random) -> int:
    event = rng.random() < 0.06
    if is_weekend(d):
        visitors = int(clamp(rng.gauss(650, 35), 600, 700))
    else:
        bias = {0: -25, 1: -15, 2: 0, 3: 10, 4: 40}[d.weekday()]
        visitors = int(clamp(rng.gauss(400 + bias, 40), 320, 500))
    if event:
        visitors = int(clamp(visitors * rng.uniform(1.25, 1.45), 320, 900))
    return visitors


def daily_consumption(visitors: int, rng: random.Random, cold_rainy: bool, weekend: bool) -> dict[str, float]:
    coffee_cups = visitors * rng.uniform(0.88, 0.96)
    dozens_used = (visitors * 0.5) / 12.0
    dairy_frac = rng.uniform(0.78, 0.88) if cold_rainy else rng.uniform(0.72, 0.82)
    dairy_cups = coffee_cups * dairy_frac
    oat_cups = coffee_cups - dairy_cups
    butter = (visitors / 400.0) * rng.uniform(0.35, 0.85)
    if weekend:
        butter *= rng.uniform(1.15, 1.4)
    return {
        "MILK-WHOLE-1GAL": dairy_cups * 0.55 * rng.uniform(0.035, 0.045),
        "MILK-2PCT-1GAL": dairy_cups * 0.25 * rng.uniform(0.030, 0.040),
        "MILK-OAT-1L": oat_cups * rng.uniform(0.18, 0.22),
        "EGG-LG-DZ": dozens_used,
        "HALFHALF-QT": coffee_cups * 0.15 * rng.uniform(0.04, 0.06),
        "BUTTER-UNSALT-LB": butter,
    }


def main() -> None:
    rng = random.Random(SEED)
    OUT.mkdir(parents=True, exist_ok=True)

    qty = {s.sku_id: s.starting_qty for s in SKUS}
    sku_by_id = {s.sku_id: s for s in SKUS}
    daily_use_hist: dict[str, list[tuple[date, float]]] = {s.sku_id: [] for s in SKUS}
    visitors_hist: list[tuple[date, int]] = []
    inventory_rows: list[dict] = []
    open_orders: list[OpenOrder] = []
    applied: set[str] = set()
    po_seq = 0

    def avg_use_7d(sku_id: str, as_of: date) -> float:
        hist = [u for d, u in daily_use_hist[sku_id] if 0 <= (as_of - d).days <= 6]
        if not hist:
            return {
                "MILK-WHOLE-1GAL": 2.2,
                "MILK-2PCT-1GAL": 1.0,
                "MILK-OAT-1L": 4.0,
                "EGG-LG-DZ": 14.0,
                "HALFHALF-QT": 2.0,
                "BUTTER-UNSALT-LB": 0.55,
            }[sku_id]
        return sum(hist) / len(hist)

    def avg_visitors_7d(as_of: date) -> float:
        hist = [v for d, v in visitors_hist if 0 <= (as_of - d).days <= 6]
        return sum(hist) / len(hist) if hist else 400.0

    def has_open(sku_id: str) -> bool:
        for o in open_orders:
            if o.sku_id != sku_id or o.cancelled_ts:
                continue
            if o.line_id in applied:
                continue
            return True
        return False

    def place_order(sku: Sku, decision_ts: datetime, q_oh: float, use7: float, runway: float, trigger: str, notes: str) -> None:
        nonlocal po_seq
        need = sku.target_cover_days * use7 - q_oh
        order_qty = min(pack_ceil(max(need, sku.pack_size), sku.pack_size), sku.par_level * 3)
        po_seq += 1
        oid = f"PO-2026-{decision_ts.strftime('%m%d')}-{po_seq:03d}"
        lid = f"{oid}-01"
        lead = max(8.0, rng.gauss(sku.lead_hours_mean, sku.lead_hours_std))

        deliver_at = decision_ts + timedelta(hours=lead)
        deliver_day = deliver_at.date() + (timedelta(days=1) if deliver_at.hour >= 12 else timedelta(0))
        deliver_ts: datetime | None = datetime.combine(deliver_day, time(5, 30)) + timedelta(minutes=rng.randint(0, 45))
        if deliver_ts <= decision_ts:
            deliver_ts = decision_ts + timedelta(hours=max(12.0, lead))

        confirmed = decision_ts + timedelta(hours=rng.uniform(4, 14))
        if confirmed >= deliver_ts:
            confirmed = decision_ts + timedelta(hours=3)
        shipped = confirmed + timedelta(hours=rng.uniform(2, 10))
        if shipped >= deliver_ts:
            shipped = deliver_ts - timedelta(minutes=30)

        roll = rng.random()
        cancelled = None
        delivered_qty = order_qty
        initial = "placed"
        if roll < 0.03:
            initial = "cancelled"
            cancelled = confirmed + timedelta(hours=2)
            deliver_ts = None
            delivered_qty = 0.0
        elif roll < 0.08:
            initial = "partial"
            delivered_qty = min(order_qty, pack_ceil(order_qty * rng.uniform(0.5, 0.85), sku.pack_size))
        elif roll < 0.14:
            initial = "delayed"
            delayed = (deliver_ts or decision_ts) + timedelta(hours=rng.uniform(12, 36))
            deliver_ts = datetime.combine(
                delayed.date() + (timedelta(days=1) if delayed.hour > 10 else timedelta(0)),
                time(5, 40),
            ) + timedelta(minutes=rng.randint(0, 30))

        open_orders.append(
            OpenOrder(
                order_id=oid,
                line_id=lid,
                sku_id=sku.sku_id,
                order_qty=order_qty,
                unit=sku.unit,
                unit_cost=sku.unit_cost,
                supplier=sku.supplier,
                trigger=trigger,
                decision_ts=decision_ts,
                placed_ts=decision_ts + timedelta(minutes=1),
                confirmed_ts=None if initial == "cancelled" else confirmed,
                shipped_ts=None if initial == "cancelled" else shipped,
                delivered_ts=deliver_ts,
                cancelled_ts=cancelled,
                initial_status=initial,
                qty_on_hand_at_decision=round_qty(q_oh, sku.unit),
                avg_daily_use_7d=round(use7, 3),
                runway_days=round(runway, 2),
                reorder_point_days=sku.reorder_point_days,
                target_cover_days=sku.target_cover_days,
                visitors_trailing_7d_avg=round(avg_visitors_7d(decision_ts.date()), 1),
                lead_time_hours=round(lead, 1),
                notes=notes,
                delivered_qty=delivered_qty,
            )
        )

    day = START_DATE
    while day <= END_DATE:
        visitors = sample_visitors(day, rng)
        visitors_hist.append((day, visitors))
        cold_rainy = rng.random() < 0.18
        day_use = daily_consumption(visitors, rng, cold_rainy, is_weekend(day))

        slot_use: dict[str, list[float]] = {s.sku_id: [] for s in SKUS}
        for share in TRAFFIC_SHARES:
            for s in SKUS:
                slot_use[s.sku_id].append(day_use[s.sku_id] * share * rng.uniform(0.85, 1.20))
        for s in SKUS:
            total = sum(slot_use[s.sku_id])
            if total > 0:
                scale = day_use[s.sku_id] / total
                slot_use[s.sku_id] = [u * scale for u in slot_use[s.sku_id]]

        used_today = {s.sku_id: 0.0 for s in SKUS}

        for idx, mins in enumerate(SLOT_MINUTES):
            hh, mm = divmod(mins, 60)
            ts = datetime.combine(day, time(hh, mm))
            restock_now: dict[str, float] = {}

            for o in open_orders:
                if o.line_id in applied:
                    continue
                if o.cancelled_ts and o.cancelled_ts <= ts:
                    continue
                if o.delivered_ts and o.delivered_ts <= ts:
                    recv = o.delivered_qty if o.delivered_qty > 0 else o.order_qty
                    qty[o.sku_id] = round_qty(qty[o.sku_id] + recv, o.unit)
                    applied.add(o.line_id)
                    restock_now[o.sku_id] = recv

            for s in SKUS:
                q_before = qty[s.sku_id]
                use = slot_use[s.sku_id][idx]
                q_after = round_qty(max(0.0, q_before - use), s.unit)
                used_today[s.sku_id] += max(0.0, q_before - q_after)
                qty[s.sku_id] = q_after
                use7 = avg_use_7d(s.sku_id, day)
                runway = q_after / max(use7, 0.05)
                inventory_rows.append(
                    {
                        "ts": ts.isoformat(timespec="seconds"),
                        "date": day.isoformat(),
                        "time": f"{hh:02d}:{mm:02d}",
                        "dow": day.strftime("%a"),
                        "is_weekend": 1 if is_weekend(day) else 0,
                        "sku_id": s.sku_id,
                        "sku_name": s.sku_name,
                        "category": s.category,
                        "unit": s.unit,
                        "qty_on_hand": q_after,
                        "par_level": s.par_level,
                        "visitors_day": visitors,
                        "restock_qty": restock_now.get(s.sku_id, 0.0),
                        "runway_days": round(runway, 2),
                        "avg_daily_use_7d": round(use7, 3),
                        "stockout_risk": 1 if q_after < 0.15 * s.par_level else 0,
                    }
                )

            if 0 < idx < len(SLOT_MINUTES) - 1:
                for s in SKUS:
                    q_oh = qty[s.sku_id]
                    use7 = avg_use_7d(s.sku_id, day)
                    runway = q_oh / max(use7, 0.05)
                    if q_oh <= 0.05 * s.par_level and not has_open(s.sku_id):
                        place_order(
                            s, ts, q_oh, use7, runway, "stockout",
                            f"Emergency: {s.sku_name} near zero mid-service",
                        )

        eod = datetime.combine(day, time(21, 30))
        for s in SKUS:
            q_oh = qty[s.sku_id]
            use7 = avg_use_7d(s.sku_id, day)
            runway = q_oh / max(use7, 0.05)
            daily_use_hist[s.sku_id].append((day, used_today[s.sku_id]))
            if has_open(s.sku_id):
                continue

            weekend_ahead = any(is_weekend(day + timedelta(days=k)) for k in (1, 2))
            trigger = None
            notes = ""
            if runway <= 2.0:
                trigger, notes = "runway", f"Hard runway {runway:.1f}d with {q_oh} {s.unit} on hand"
            elif runway <= s.reorder_point_days and weekend_ahead:
                trigger, notes = "weekend_risk", f"Soft runway {runway:.1f}d before weekend demand spike"
            elif runway <= s.reorder_point_days:
                trigger, notes = "runway", f"Runway {runway:.1f}d ≤ reorder point {s.reorder_point_days}d"
            elif (
                s.sku_id.startswith("MILK")
                and rng.random() < 0.02
                and runway < s.target_cover_days * 0.9
            ):
                trigger, notes = "standing", "Standing dairy top-up (minor); still below target cover"

            if trigger:
                place_order(s, eod, q_oh, use7, runway, trigger, notes)

        day += timedelta(days=1)

    # Finalize order statuses as of end of history
    end_ts = datetime.combine(END_DATE, time(22, 0))
    order_rows: list[dict] = []
    for o in open_orders:
        if o.cancelled_ts or o.initial_status == "cancelled":
            final = "cancelled"
        elif o.line_id in applied:
            final = "partial" if o.initial_status == "partial" or (
                o.delivered_qty and o.delivered_qty < o.order_qty - 1e-6
            ) else "delivered"
        elif o.delivered_ts and o.delivered_ts > end_ts:
            final = "delayed" if o.initial_status == "delayed" else (
                "in_transit" if o.shipped_ts and o.shipped_ts <= end_ts else (
                    "confirmed" if o.confirmed_ts and o.confirmed_ts <= end_ts else "placed"
                )
            )
        elif o.shipped_ts and o.shipped_ts <= end_ts:
            final = "in_transit"
        elif o.confirmed_ts and o.confirmed_ts <= end_ts:
            final = "confirmed"
        else:
            final = "placed"

        actual_lead = (
            round((o.delivered_ts - o.decision_ts).total_seconds() / 3600.0, 1)
            if o.delivered_ts else ""
        )
        order_rows.append(
            {
                "order_id": o.order_id,
                "line_id": o.line_id,
                "sku_id": o.sku_id,
                "sku_name": sku_by_id[o.sku_id].sku_name,
                "decision_ts": o.decision_ts.isoformat(timespec="seconds"),
                "decision_date": o.decision_ts.date().isoformat(),
                "dow": o.decision_ts.strftime("%a"),
                "qty_on_hand_at_decision": o.qty_on_hand_at_decision,
                "avg_daily_use_7d": o.avg_daily_use_7d,
                "runway_days": o.runway_days,
                "reorder_point_days": o.reorder_point_days,
                "target_cover_days": o.target_cover_days,
                "visitors_trailing_7d_avg": o.visitors_trailing_7d_avg,
                "trigger": o.trigger,
                "order_qty": o.order_qty,
                "unit": o.unit,
                "unit_cost": o.unit_cost,
                "order_total": round(o.order_qty * o.unit_cost, 2),
                "status": final,
                "placed_ts": o.placed_ts.isoformat(timespec="seconds"),
                "confirmed_ts": o.confirmed_ts.isoformat(timespec="seconds") if o.confirmed_ts else "",
                "shipped_ts": o.shipped_ts.isoformat(timespec="seconds") if o.shipped_ts else "",
                "delivered_ts": o.delivered_ts.isoformat(timespec="seconds") if o.delivered_ts else "",
                "cancelled_ts": o.cancelled_ts.isoformat(timespec="seconds") if o.cancelled_ts else "",
                "delivered_qty": o.delivered_qty if final in ("delivered", "partial") else "",
                "supplier": o.supplier,
                "lead_time_hours": o.lead_time_hours,
                "actual_lead_time_hours": actual_lead,
                "notes": o.notes,
            }
        )

    # Write files
    hist_path = OUT / "inventory_history.csv"
    with hist_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(inventory_rows[0].keys()))
        w.writeheader()
        w.writerows(inventory_rows)

    last_ts = max(r["ts"] for r in inventory_rows)
    current = [r for r in inventory_rows if r["ts"] == last_ts]
    cur_path = OUT / "inventory_current.csv"
    with cur_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(current[0].keys()))
        w.writeheader()
        w.writerows(current)

    orders_by_day_sku = {(o["decision_date"], o["sku_id"]) for o in order_rows}
    runway_rows = []
    for r in inventory_rows:
        if r["time"] != "21:30":
            continue
        runway_rows.append(
            {
                "date": r["date"],
                "dow": r["dow"],
                "is_weekend": r["is_weekend"],
                "sku_id": r["sku_id"],
                "sku_name": r["sku_name"],
                "qty_eod": r["qty_on_hand"],
                "avg_daily_use_7d": r["avg_daily_use_7d"],
                "runway_days": r["runway_days"],
                "visitors_day": r["visitors_day"],
                "order_placed": 1 if (r["date"], r["sku_id"]) in orders_by_day_sku else 0,
            }
        )
    run_path = OUT / "runway_daily.csv"
    with run_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(runway_rows[0].keys()))
        w.writeheader()
        w.writerows(runway_rows)

    ord_path = OUT / "orders.csv"
    with ord_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(order_rows[0].keys()))
        w.writeheader()
        w.writerows(order_rows)

    open_only = [o for o in order_rows if o["status"] in ("placed", "confirmed", "in_transit", "delayed")]
    open_path = OUT / "orders_open.csv"
    with open_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(order_rows[0].keys()))
        w.writeheader()
        w.writerows(open_only)

    triggers: dict[str, int] = {}
    statuses: dict[str, int] = {}
    for o in order_rows:
        triggers[o["trigger"]] = triggers.get(o["trigger"], 0) + 1
        statuses[o["status"]] = statuses.get(o["status"], 0) + 1

    readme = OUT / "DATASETS.md"
    readme.write_text(
        f"""# Coffee-shop fridge datasets

Synthetic skewed operational data for a café fridge (MilkWatch agent context).

## Coverage
- Dates: **{START_DATE} → {END_DATE}** ({DAYS} days)
- Snapshots: **every 30 min, 06:00–21:30** (32/day)
- Visitors: ~400 weekdays, ~600–700 weekends; ~92% buy coffee; **0.5 eggs/person**
- Orders: **demand-driven** via `runway_days = qty / avg_daily_use_7d` (not a fixed calendar)

## Files
| File | Rows | Purpose |
|------|------|---------|
| `inventory_history.csv` | {len(inventory_rows)} | 30-min SKU levels |
| `inventory_current.csv` | {len(current)} | latest snap (agent) |
| `runway_daily.csv` | {len(runway_rows)} | EOD runway + order flag |
| `orders.csv` | {len(order_rows)} | PO lifecycle |
| `orders_open.csv` | {len(open_only)} | not yet delivered |

## Order mix
- Triggers: `{triggers}`
- Statuses: `{statuses}`

## Regenerate
```bash
cd part2_linq && python3 scripts/generate_cafe_datasets.py
```
Seed={SEED}.
""",
        encoding="utf-8",
    )

    print("Wrote:")
    for p, n in [
        (hist_path, len(inventory_rows)),
        (cur_path, len(current)),
        (run_path, len(runway_rows)),
        (ord_path, len(order_rows)),
        (open_path, len(open_only)),
    ]:
        print(f"  {p.name}: {n} rows")
    print("Triggers:", triggers)
    print("Statuses:", statuses)
    print("Current inventory:")
    for r in sorted(current, key=lambda x: x["sku_id"]):
        print(f"  {r['sku_id']}: {r['qty_on_hand']} {r['unit']} (runway {r['runway_days']}d)")


if __name__ == "__main__":
    main()
