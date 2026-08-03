# Coffee-shop fridge datasets

Synthetic skewed operational data for a café fridge (MilkWatch agent context).

## Coverage
- Dates: **2026-06-03 → 2026-08-01** (60 days)
- Snapshots: **every 30 min, 06:00–21:30** (32/day)
- Visitors: ~400 weekdays, ~600–700 weekends; ~92% buy coffee; **0.5 eggs/person**
- Orders: **demand-driven** via `runway_days = qty / avg_daily_use_7d` (not a fixed calendar)

## Files
| File | Rows | Purpose |
|------|------|---------|
| `inventory_history.csv` | 11520 | 30-min SKU levels |
| `inventory_current.csv` | 6 | latest snap (agent) |
| `runway_daily.csv` | 360 | EOD runway + order flag |
| `orders.csv` | 122 | PO lifecycle |
| `orders_open.csv` | 4 | not yet delivered |

## Order mix
- Triggers: `{'stockout': 3, 'runway': 94, 'weekend_risk': 25}`
- Statuses: `{'delivered': 105, 'partial': 10, 'cancelled': 3, 'in_transit': 1, 'placed': 3}`

## Regenerate
```bash
cd part2_linq && python3 scripts/generate_cafe_datasets.py
```
Seed=42.
