"""Quote arithmetic in Decimal. Every stage rounds half-up to cents so totals re-add exactly."""
from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")
ZERO = Decimal("0")


def cents(value) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def fmt(value) -> str:
    return f"{cents(value):,.2f}"


def line_amounts(quantity, unit_cost, waste_pct, hours_per_unit, labor_rate) -> tuple[Decimal, Decimal]:
    qty = Decimal(str(quantity))
    material = cents(qty * Decimal(str(unit_cost)) * (1 + Decimal(str(waste_pct))))
    labor = cents(qty * Decimal(str(hours_per_unit)) * Decimal(str(labor_rate)))
    return material, labor


def calculate_quote(rows, overhead_pct, markup_pct, tax_rate, delivery, discount) -> dict:
    """rows: dicts with quantity, material_unit_cost, waste_pct, labor_hours_per_unit, labor_rate."""
    material = ZERO
    labor = ZERO
    for r in rows:
        line_material, line_labor = line_amounts(r["quantity"], r["material_unit_cost"], r["waste_pct"], r["labor_hours_per_unit"], r["labor_rate"])
        material += line_material
        labor += line_labor
    material, labor = cents(material), cents(labor)
    base = material + labor
    overhead = cents(base * Decimal(str(overhead_pct)))
    subtotal = base + overhead
    markup = cents(subtotal * Decimal(str(markup_pct)))
    marked = subtotal + markup
    taxable = max(ZERO, marked + cents(delivery) - cents(discount))
    tax = cents(taxable * Decimal(str(tax_rate)))
    total = taxable + tax
    return {
        "materials": material, "labor": labor, "base": base, "overhead": overhead,
        "subtotal": subtotal, "markup": markup, "delivery": cents(delivery),
        "discount": cents(discount), "tax": tax, "total": total,
    }
