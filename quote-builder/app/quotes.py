"""Quote construction: source-backed line pricing, hashed immutable snapshots, and customer-text slot filling."""
import hashlib
import json
import re
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from fastapi import HTTPException

from app.audit import audit
from app.money import calculate_quote, cents, fmt, line_amounts

REVIEW_THRESHOLD = Decimal("5000")
PRICE_LIST_STALE_DAYS = 90
SLOT = re.compile(r"\{\{(line_(\d+)_total|grand_total)\}\}")


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def snapshot_hash(snapshot: dict) -> str:
    return hashlib.sha256(canonical(snapshot).encode()).hexdigest()


def load_profile(c, tenant_id):
    return c.execute("SELECT * FROM contractor_profiles WHERE tenant_id=?", (tenant_id,)).fetchone()


def _now_utc() -> datetime:
    return datetime.now(UTC)


def resolve_source(c, tenant_id, scope):
    """Returns (unit_cost, source_ref, None) or (None, None, reason). Fails closed on anything unverifiable."""
    kind, sid = scope["source_type"], scope["source_id"]
    if kind == 'supplier_snapshot':
        item = c.execute('SELECT * FROM supplier_snapshots WHERE id=? AND tenant_id=? AND scope_id=?', (sid, tenant_id, scope['id'])).fetchone()
        if not item or scope['unit'] != 'set' or scope['quantity'] != 1:
            return None, None, 'supplier snapshot does not match this scope'
        return Decimal(item['amount_cents']) / 100, {'type': 'supplier_snapshot', 'id': item['id']}, None
    if kind == "price_item":
        item = c.execute(
            "SELECT pi.id, pi.name, pi.unit, pi.unit_price, pi.source_row, pl.sha256, pl.uploaded_at "
            "FROM price_items pi JOIN price_lists pl ON pl.id = pi.price_list_id WHERE pi.id=? AND pi.tenant_id=?",
            (sid, tenant_id)).fetchone()
        if not item:
            return None, None, "price item not found in this workspace"
        if item["unit"] != scope["unit"]:
            return None, None, f"unit mismatch: scope is '{scope['unit']}', price is '{item['unit']}'"
        ref = {"type": "price_item", "id": item["id"], "name": item["name"], "unit": item["unit"],
               "source_row": item["source_row"], "list_sha256": item["sha256"], "list_uploaded_at": item["uploaded_at"]}
        return Decimal(item["unit_price"]), ref, None
    if kind == "evidence":
        ev = c.execute("SELECT * FROM evidence WHERE id=? AND tenant_id=?", (sid, tenant_id)).fetchone()
        if not ev or ev["scope_id"] != scope["id"]:
            return None, None, "evidence is not linked to this scope"
        if not ev["stock_confirmed"] or not ev["commercial_use"]:
            return None, None, "evidence lacks stock confirmation or commercial-use permission"
        if ev["currency"] != "USD":
            return None, None, "evidence currency is not USD"
        if not ev["valid_until"] or date.fromisoformat(ev["valid_until"]) < _now_utc().date():
            return None, None, "evidence is expired or has no validity date"
        if ev["unit"] != scope["unit"]:
            return None, None, f"unit mismatch: scope is '{scope['unit']}', evidence is '{ev['unit']}'"
        ref = {"type": "evidence", "id": ev["id"], "supplier": ev["supplier"], "sha256": ev["sha256"],
               "valid_until": ev["valid_until"]}
        return cents(str(ev["unit_cost"])), ref, None
    return None, None, "no source attached"


def build_quote(c, u, project_id: str, policy: dict, customer_text: dict | None = None,
                customer: dict | None = None, job_id: str | None = None, supplier_agents: dict | None = None) -> dict:
    project = c.execute("SELECT * FROM projects WHERE id=? AND tenant_id=?", (project_id, u["tenant_id"])).fetchone()
    if not project:
        raise HTTPException(404, "Project not found")
    profile = load_profile(c, u["tenant_id"])
    if not profile or profile["labor_rate"] is None:
        raise HTTPException(422, "Set a labor rate in the contractor profile before quoting")
    if customer is None:
        owner = c.execute("SELECT name FROM customers WHERE id=?", (project["customer_id"],)).fetchone() if project["customer_id"] else None
        customer = {"name": owner["name"] if owner else None, "project_name": project["name"]}
    scopes = c.execute("SELECT * FROM scopes WHERE project_id=? AND tenant_id=? ORDER BY rowid",
                       (project_id, u["tenant_id"])).fetchall()
    if not scopes:
        raise HTTPException(422, "Add at least one scope before creating a quote")

    unsourced, warnings, lines = [], [], []
    labor_rate = Decimal(profile["labor_rate"])
    for s in scopes:
        unit_cost, ref, reason = resolve_source(c, u["tenant_id"], s)
        if reason:
            unsourced.append({"scope_id": s["id"], "description": s["description"], "reason": reason})
            continue
        if ref["type"] == "price_item":
            listed = datetime.fromisoformat(ref["list_uploaded_at"])
            if _now_utc() - listed > timedelta(days=PRICE_LIST_STALE_DAYS):
                warnings.append(f"Price list for '{ref['name']}' is more than {PRICE_LIST_STALE_DAYS} days old")
        material, labor = line_amounts(s["quantity"], unit_cost, s["waste_pct"], s["labor_hours_per_unit"], labor_rate)
        lines.append({"scope_id": s["id"], "description": s["description"], "quantity": str(s["quantity"]),
                      "unit": s["unit"], "unit_cost": str(unit_cost), "waste_pct": str(s["waste_pct"]),
                      "labor_hours_per_unit": str(s["labor_hours_per_unit"]), "labor_rate": str(labor_rate),
                      "source": ref, "line_total": str(material + labor),
                      "_material": material, "_labor": labor})
    warnings = list(dict.fromkeys(warnings))
    if unsourced:
        raise HTTPException(422, {"message": "Lines without a valid, current source cannot be quoted", "unsourced": unsourced})

    calc = calculate_quote(
        [{"quantity": line["quantity"], "material_unit_cost": line["unit_cost"], "waste_pct": line["waste_pct"],
          "labor_hours_per_unit": line["labor_hours_per_unit"], "labor_rate": line["labor_rate"]} for line in lines],
        policy["overhead_pct"], policy["markup_pct"], policy["tax_rate"], policy["delivery"], policy["discount"])
    line_totals = [line["_material"] + line["_labor"] for line in lines]
    filled = None
    if customer_text is not None:
        if len(customer_text["lines_text"]) != len(lines):
            raise HTTPException(422, "Customer text does not match the priced lines (drift)")
        try:
            filled = {
                "lines_text": [fill_slots(t, line_totals, calc["total"]) for t in customer_text["lines_text"]],
                "total_text": fill_slots(customer_text["total_text"], line_totals, calc["total"]),
                "scope_text": customer_text["scope_text"], "assumptions": customer_text["assumptions"],
                "exclusions": customer_text["exclusions"],
            }
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    for line in lines:
        del line["_material"], line["_labor"]
    review_required = calc["total"] > REVIEW_THRESHOLD
    if review_required:
        warnings.append(f"Total is over {REVIEW_THRESHOLD}: review before sending")
    costs = {k: str(v) for k, v in calc.items()}
    version = c.execute("SELECT COALESCE(MAX(version),0)+1 FROM quotes WHERE project_id=?", (project_id,)).fetchone()[0]
    snapshot = {
        "project_id": project_id, "version": version, "job_id": job_id,
        "customer": customer or {}, "policy": {k: str(v) for k, v in policy.items()},
        "profile": {"license_line": f"License: {profile['license_number']}" if profile["license_number"] else None,
                    "insurance_line": profile["insurance_text"], "payment_terms": profile["payment_terms"],
                    "valid_until_days": profile["valid_until_days"]},
        "lines": lines, "customer_text": filled, "costs": costs,
        "review_required": review_required, "warnings": warnings,
    }
    if supplier_agents is not None:
        snapshot['supplier_agents'] = supplier_agents
        if supplier_agents['supplier']['data'].get('sample_data'):
            warnings.append('SAMPLE SUPPLIER DATA: this is not a live commercial quote.')
    digest = snapshot_hash(snapshot)
    eid = str(uuid.uuid4())
    c.execute("UPDATE quotes SET status='superseded' WHERE project_id=? AND status='draft'", (project_id,))
    c.execute(
        "INSERT INTO quotes(id,tenant_id,project_id,version,overhead_pct,markup_pct,tax_rate,discount,delivery,subtotal,total,"
        "created_by,snapshot_json,snapshot_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (eid, u["tenant_id"], project_id, version, float(policy["overhead_pct"]), float(policy["markup_pct"]),
         float(policy["tax_rate"]), float(calc["discount"]), float(calc["delivery"]), float(calc["subtotal"]),
         float(calc["total"]), u["id"], canonical(snapshot), digest))
    audit(c, u, "create", "quote", eid, {"version": version, "snapshot_hash": digest, "review_required": review_required})
    return {"id": eid, "project_id": project_id, "version": version, "status": "draft", "snapshot_hash": digest,
            "review_required": review_required, "warnings": warnings, "costs": costs}


def fill_slots(text: str, line_totals: list[Decimal], grand_total: Decimal) -> str:
    def replace(match):
        if match.group(1) == "grand_total":
            return fmt(grand_total)
        index = int(match.group(2))
        if not (1 <= index <= len(line_totals)):
            raise ValueError(f"slot {match.group(0)} refers to a line that does not exist")
        return fmt(line_totals[index - 1])
    return SLOT.sub(replace, text)


def digits_outside_known_text(texts: list[str], known_names: list[str]) -> str | None:
    """Customer text may contain digits only inside slots or inside an item name from the estimate.

    Returns the first offending token, or None. This is how the Writer's "never types a number" rule is enforced.
    """
    haystack = " ".join(known_names).lower()
    for text in texts:
        stripped = SLOT.sub("", text)
        for token in re.findall(r"\S*\d\S*", stripped):
            if token.lower().strip(".,;:()") not in haystack:
                return token
    return None


