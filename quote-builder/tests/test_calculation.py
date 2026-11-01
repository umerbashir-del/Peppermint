from decimal import Decimal

from app.money import calculate_quote, cents

ROW = {"quantity": 10, "material_unit_cost": 20, "waste_pct": 0.1, "labor_hours_per_unit": 2, "labor_rate": 45}


def test_worked_example_matches_hand_calculation():
    k = calculate_quote([ROW], 0.1, 0.2, 0.08, 50, 25)
    assert k["materials"] == Decimal("220.00")
    assert k["labor"] == Decimal("900.00")
    assert k["base"] == Decimal("1120.00")
    assert k["overhead"] == Decimal("112.00")
    assert k["markup"] == Decimal("246.40")
    assert k["tax"] == Decimal("120.27")
    assert k["total"] == Decimal("1623.67")


def test_totals_are_exact_decimals_not_float_drift():
    rows = [{"quantity": 0.1, "material_unit_cost": 0.1, "waste_pct": 0, "labor_hours_per_unit": 0, "labor_rate": 0}] * 3
    k = calculate_quote(rows, 0, 0, 0, 0, 0)
    assert k["materials"] == Decimal("0.03")


def test_taxable_never_negative_when_discount_exceeds_total():
    k = calculate_quote([ROW], 0, 0, 0.08, 0, 99999)
    assert k["total"] == Decimal("0.00")


def test_cents_rounds_half_up():
    assert cents("2.345") == Decimal("2.35")
