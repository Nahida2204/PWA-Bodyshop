"""
vehicle_prices.py
─────────────────
Reads kia_model_averages.csv (two columns: model, avg_showroom_price)
and provides total loss / economic loss decision logic.

kia_prices.csv is NOT required.
"""

import csv, os, datetime

_AVG_CSV = os.path.join(os.path.dirname(__file__), "kia_model_averages.csv")

# ── Load averages once at import ──────────────────────────────────────────────

def _load() -> dict:
    result = {}
    with open(_AVG_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            model = row["model"].strip()
            price = int(row["avg_showroom_price"].strip())
            result[model.lower()] = {
                "model":              model,
                "avg_showroom_price": price,
            }
    return result

_AVERAGES: dict = _load()


# ── Public helpers ────────────────────────────────────────────────────────────

def list_models() -> list[str]:
    """Return sorted list of model names."""
    return sorted(v["model"] for v in _AVERAGES.values())


def get_average_price(model: str) -> dict | None:
    """
    Return average showroom price for a model (case-insensitive).
    Returns { model, avg_showroom_price } or None if not found.
    """
    return _AVERAGES.get(model.lower().strip())


def reload():
    """Reload CSV from disk — call if the file is updated at runtime."""
    global _AVERAGES
    _AVERAGES = _load()


# ══════════════════════════════════════════════════════════════════════════════
# TOTAL LOSS / ECONOMIC LOSS DECISION
# ══════════════════════════════════════════════════════════════════════════════
#
# Pre-accident value = avg_showroom_price x (0.85 ^ age_years)
#   Reducing balance: 15% depreciation per year
#
# Total loss if: repair_estimate_excl_vat >= 60% of pre_accident_value

DEPRECIATION_RATE    = 0.15   # 15% per year reducing balance
TOTAL_LOSS_THRESHOLD = 0.60   # 60%


def calc_pre_accident_value(showroom_price: int, vehicle_year: int,
                             accident_year: int | None = None) -> dict:
    if accident_year is None:
        accident_year = datetime.date.today().year

    age_years = max(0, accident_year - vehicle_year)
    factor    = (1 - DEPRECIATION_RATE) ** age_years
    pav       = round(showroom_price * factor)

    return {
        "showroom_price":      showroom_price,
        "vehicle_year":        vehicle_year,
        "accident_year":       accident_year,
        "age_years":           age_years,
        "depreciation_factor": round(factor, 4),
        "pre_accident_value":  pav,
        "depreciation_amount": showroom_price - pav,
    }


def total_loss_decision(repair_estimate_excl_vat: int,
                        showroom_price: int,
                        vehicle_year: int,
                        accident_year: int | None = None) -> dict:
    pav_data   = calc_pre_accident_value(showroom_price, vehicle_year, accident_year)
    pav        = pav_data["pre_accident_value"]
    threshold  = round(pav * TOTAL_LOSS_THRESHOLD)
    repair_pct = round((repair_estimate_excl_vat / pav) * 100, 1) if pav > 0 else 0.0
    is_total   = repair_estimate_excl_vat >= threshold

    note = (
        f"Repair estimate (Rs {repair_estimate_excl_vat:,}) is "
        f"{repair_pct}% of the pre-accident value (Rs {pav:,}), "
        f"exceeding the 60% threshold (Rs {threshold:,}). "
        f"Vehicle is declared a total / economic loss."
    ) if is_total else (
        f"Repair estimate (Rs {repair_estimate_excl_vat:,}) is "
        f"{repair_pct}% of the pre-accident value (Rs {pav:,}). "
        f"Below the 60% threshold (Rs {threshold:,}) - vehicle is repairable."
    )

    return {
        **pav_data,
        "repair_estimate":   repair_estimate_excl_vat,
        "threshold_amount":  threshold,
        "threshold_pct":     TOTAL_LOSS_THRESHOLD * 100,
        "repair_pct_of_pav": repair_pct,
        "is_total_loss":     is_total,
        "decision":          "TOTAL LOSS" if is_total else "REPAIRABLE",
        "decision_note":     note,
    }