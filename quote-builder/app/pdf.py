"""Renders an approved quote from its snapshot. The PDF can only show what the snapshot holds, so approval covers it."""
import io
from decimal import Decimal
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def _p(text, style):
    return Paragraph(escape(str(text or "")), style)


def _num(value) -> str:
    """'40.0' -> '40', '2.5' -> '2.5'. Money is not formatted here; the snapshot already holds cent strings."""
    return format(Decimal(str(value)).normalize(), "f")


def render_quote_pdf(snapshot: dict, quote_id: str, snapshot_hash: str, status: str) -> bytes:
    styles = getSampleStyleSheet()
    customer = snapshot.get("customer") or {}
    profile = snapshot.get("profile") or {}
    text = snapshot.get("customer_text") or {}
    costs = snapshot.get("costs") or {}
    story = [
        _p("Quote", styles["Title"]),
        _p(f"Customer: {customer.get('name', '')}", styles["Normal"]),
        _p(f"Site: {customer.get('project_name', '')}", styles["Normal"]),
        _p(f"Quote version {snapshot.get('version')} · status {status}", styles["Normal"]),
        Spacer(1, 12),
    ]
    if any(str(warning).startswith('SAMPLE SUPPLIER DATA:') for warning in snapshot.get('warnings', [])):
        story += [_p('DEMO — SAMPLE SUPPLIER DATA', styles['Heading2']),
                  _p('For demonstration only. Prices, stock, and account figures are synthetic; this is not a live commercial quote.', styles['Normal']), Spacer(1, 12)]
    if text.get("scope_text"):
        story += [_p("Scope of work", styles["Heading3"]), _p(text["scope_text"], styles["Normal"]), Spacer(1, 8)]
    # Customer wording (slots already filled and checked) when present; otherwise the item descriptions with direct cost.
    wording = text.get("lines_text")
    if wording:
        rows = [["Item"]] + [[_p(line, styles["Normal"])] for line in wording]
        widths = [480]
    else:
        rows = [["Item", "Qty", "Unit", "Direct cost"]]
        rows += [[_p(item["description"], styles["Normal"]), _num(item["quantity"]), item["unit"], item["line_total"]]
                 for item in snapshot.get("lines", [])]
        widths = [300, 60, 60, 90]
    table = Table(rows, colWidths=widths)
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e0e7f0")),
                               ("GRID", (0, 0), (-1, -1), 0.25, colors.grey)]))
    story += [table, Spacer(1, 10)]
    story += [_p(f"Subtotal: {costs.get('subtotal')}", styles["Normal"]), _p(f"Tax: {costs.get('tax')}", styles["Normal"]),
              _p(f"Total: {costs.get('total')}", styles["Heading2"]), Spacer(1, 10)]
    if snapshot.get("customer_text") and text.get("total_text"):
        story += [_p(text["total_text"], styles["Normal"]), Spacer(1, 8)]
    for heading, key in (("Assumptions", "assumptions"), ("Exclusions", "exclusions")):
        items = text.get(key) or []
        if items:
            story.append(_p(heading, styles["Heading3"]))
            story += [_p(f"- {item}", styles["Normal"]) for item in items]
            story.append(Spacer(1, 8))
    if profile.get("license_line"):
        story.append(_p(profile["license_line"], styles["Normal"]))
    if profile.get("insurance_line"):
        story.append(_p(profile["insurance_line"], styles["Normal"]))
    if profile.get("payment_terms"):
        story.append(_p(f"Payment terms: {profile['payment_terms']}", styles["Normal"]))
    story.append(_p(f"This quote is valid for {profile.get('valid_until_days', 30)} days.", styles["Normal"]))
    story += [Spacer(1, 16), _p(f"Quote {quote_id} · snapshot {snapshot_hash}", styles["Italic"])]
    buffer = io.BytesIO()
    SimpleDocTemplate(buffer, pagesize=letter, title="Quote", author="Quote Builder Crew").build(story)
    return buffer.getvalue()
