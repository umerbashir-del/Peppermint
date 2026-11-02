"""The crew: Pricing team and Quote team run in parallel, then a deterministic join.

Each team is a lead agent with its own budget. The leads never talk to each other; they only read
each other's finished files. Code, not a model, decides whether the two halves agree.
"""
import asyncio
import difflib
import json
import os
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.crew import contracts
from app.progress import crew_event
from app.crew.llm import Budget, Gateway
from app.crew.prompts import load_prompt
from app.quotes import SLOT, digits_outside_known_text

TEAM_TIMEOUT_SECONDS = float(os.getenv("QBC_CREW_TIMEOUT_SECONDS", "120"))
LEAD_BUDGET_USD = 0.25
LEAD_MAX_TURNS = 15
WRITER_BUDGET_USD = 0.05
WRITER_MAX_TURNS = 4
WRITER_ATTEMPTS = 2
NAME_MATCH_MIN = 0.5
CANDIDATES_PER_ITEM = 5


def _now() -> str:
    return datetime.now(UTC).isoformat()


class Workspace:
    """Each file has one owning team. A write from any other team is refused by the harness."""

    OWNERS = {"pricing.json": "pricing", "quote_shell.json": "quote", "writer.json": "quote"}

    def __init__(self) -> None:
        self.files: dict[str, Any] = {}
        self.trace: list[dict] = []

    def write(self, team: str, name: str, data: Any) -> None:
        if self.OWNERS.get(name) != team:
            raise PermissionError(f"{team} may not write {name}")
        self.files[name] = data

    def event(self, team: str, kind: str, **detail: Any) -> None:
        # Counts and categories only. Raw model output is never written to the trace.
        self.trace.append({"at": _now(), "mono": time.monotonic(), "team": team, "event": kind, **detail})
        crew_event(team, kind, detail)


@dataclass
class CrewResult:
    status: str  # ready | needs_input | failed
    failed_half: str | None = None
    items: list[dict] = field(default_factory=list)
    missing: list[dict] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)
    customer_text: dict | None = None
    trace: list[dict] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


def _similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _candidates(catalog: list[dict], item: contracts.PlannedItem) -> list[dict]:
    """Same-unit price items only, so a unit mismatch can never be offered as a match."""
    same_unit = [p for p in catalog if p["unit"] == item.unit]
    names = sorted({p["name"].lower() for p in same_unit})
    close = set(difflib.get_close_matches(item.name.lower(), names, n=CANDIDATES_PER_ITEM, cutoff=0.3))
    return [{"id": p["id"], "name": p["name"], "unit_price": p["unit_price"]}
            for p in same_unit if p["name"].lower() in close][: CANDIDATES_PER_ITEM * 2]


async def pricing_team(ctx: "CrewContext") -> dict:
    ws = ctx.workspace
    ws.event("pricing", "start")
    budget = Budget(LEAD_BUDGET_USD, LEAD_MAX_TURNS)
    raw = await ctx.llm.complete("strong", "pricing_lead", load_prompt("pricing_lead"),
                                 f"<notes>\n{ctx.notes}\n</notes>", budget)
    plan = contracts.parse(raw, contracts.PricingPlan)
    ws.event("pricing", "plan", items=len(plan.items))

    by_id = {p["id"]: p for p in ctx.catalog}
    by_trade: dict[str, list[tuple[int, contracts.PlannedItem]]] = defaultdict(list)
    for index, item in enumerate(plan.items):
        by_trade[item.trade].append((index, item))

    async def estimate_trade(trade: str, entries: list[tuple[int, contracts.PlannedItem]]) -> list[dict]:
        ws.event("pricing", "estimator_start", trade=trade, items=len(entries))
        candidates = {i: _candidates(ctx.catalog, item) for i, item in entries}
        payload = [{"index": i, "name": item.name, "unit": item.unit, "quantity": item.quantity,
                    "candidates": [{"id": c["id"], "name": c["name"]} for c in candidates[i]]}
                   for i, item in entries]
        raw_choice = await ctx.llm.complete("mid", "estimator", load_prompt("estimator"),
                                            f"<items>\n{json.dumps(payload)}\n</items>", budget)
        choice = contracts.parse(raw_choice, contracts.EstimatorChoice)
        allowed = {i for i, _ in entries}
        chosen: dict[int, str] = {}
        for match in choice.matches:
            if match.index not in allowed or match.price_item_id is None:
                continue
            if match.price_item_id in {c["id"] for c in candidates[match.index]}:
                chosen[match.index] = match.price_item_id
        results = []
        for i, item in entries:
            if i in chosen:
                price = by_id[chosen[i]]
                results.append({"index": i, "trade": trade, "name": item.name, "quantity": item.quantity,
                                "unit": item.unit, "labor_hours_per_unit": item.labor_hours_per_unit,
                                "waste_pct": item.waste_pct, "price_item_id": price["id"],
                                "price_name": price["name"], "unit_cost": price["unit_price"]})
            else:
                results.append({"index": i, "trade": trade, "name": item.name, "quantity": item.quantity,
                                "unit": item.unit, "reason": "no matching price list item"})
        ws.event("pricing", "estimator_done", trade=trade, priced=len(chosen), missing=len(entries) - len(chosen))
        return results

    per_trade = await asyncio.gather(*(estimate_trade(t, e) for t, e in by_trade.items()))
    rows = sorted((row for group in per_trade for row in group), key=lambda r: r["index"])
    estimate: dict[str, Any] = {"version": 1,
                "items": [r for r in rows if "price_item_id" in r],
                "missing": [r for r in rows if "price_item_id" not in r]}
    ws.write("pricing", "pricing.json", estimate)
    ws.event("pricing", "done", priced=len(estimate["items"]), missing=len(estimate["missing"]))
    return estimate


def _writer_problems(writer: contracts.WriterOut, shell: contracts.QuoteShell) -> list[str]:
    problems = []
    if len(writer.lines_text) != len(shell.line_labels):
        problems.append("line count does not match the labels")
    token = digits_outside_known_text(writer.lines_text + [writer.total_text], shell.line_labels)
    if token:
        problems.append(f"number '{token}' is not a slot")
    return problems


async def quote_team(ctx: "CrewContext") -> dict:
    ws = ctx.workspace
    ws.event("quote", "start")
    budget = Budget(LEAD_BUDGET_USD, LEAD_MAX_TURNS)
    raw = await ctx.llm.complete("strong", "quote_lead", load_prompt("quote_lead"),
                                 f"<notes>\n{ctx.notes}\n</notes>", budget)
    shell = contracts.parse(raw, contracts.QuoteShell)
    ws.write("quote", "quote_shell.json", shell.model_dump())
    ws.event("quote", "shell_done", labels=len(shell.line_labels))

    writer_budget = Budget(WRITER_BUDGET_USD, WRITER_MAX_TURNS)
    feedback: list[str] = []
    previous_raw = None
    for attempt in range(WRITER_ATTEMPTS):
        raw_writer = await ctx.llm.complete(
            "small", "writer", load_prompt("writer"),
            "<scope>\n" + json.dumps({"line_labels": shell.line_labels, "feedback": feedback}) + "\n</scope>",
            writer_budget)
        if raw_writer == previous_raw:
            ws.event("quote", "repeat_action_stop")
            break
        previous_raw = raw_writer
        writer = contracts.parse(raw_writer, contracts.WriterOut)
        problems = _writer_problems(writer, shell)
        if not problems:
            ws.write("quote", "writer.json", writer.model_dump())
            ws.event("quote", "writer_done", attempts=attempt + 1)
            return {"shell": shell.model_dump(), "writer": writer.model_dump()}
        feedback = problems
        ws.event("quote", "writer_rejected", attempt=attempt + 1, reasons=len(problems))
    raise contracts.ContractError("Writer output could not pass the number check")


def join(estimate: dict, quote: dict, expected_version: int = 1) -> list[str]:
    """Deterministic checks across the two halves. Returns problems; an empty list means the halves agree."""
    problems: list[str] = []
    shell, writer = quote["shell"], quote["writer"]
    items = estimate["items"]
    if estimate["version"] != expected_version:
        problems.append("estimate version is stale")
    if len(shell["line_labels"]) != len(items):
        problems.append("scope and estimate have different line counts")
    else:
        for label, item in zip(shell["line_labels"], items, strict=True):
            if _similarity(label, item["name"]) < NAME_MATCH_MIN:
                problems.append(f"scope label '{label}' does not match priced item '{item['name']}'")
    texts = [shell["scope_text"], *shell["assumptions"], *shell["exclusions"], *writer["lines_text"], writer["total_text"]]
    token = digits_outside_known_text(texts, [i["name"] for i in items])
    if token:
        problems.append(f"number '{token}' in customer text did not come from a slot or a price item")
    for text in writer["lines_text"] + [writer["total_text"]]:
        for match in SLOT.finditer(text):
            if match.group(1) != "grand_total" and int(match.group(2)) > len(items):
                problems.append(f"slot {match.group(0)} refers to a line that does not exist")
    return problems


@dataclass
class CrewContext:
    llm: Gateway
    catalog: list[dict]
    notes: str
    workspace: Workspace


async def run_crew(notes: str, catalog: list[dict], llm: Gateway,
                   timeout: float = TEAM_TIMEOUT_SECONDS) -> CrewResult:
    ws = Workspace()
    ctx = CrewContext(llm=llm, catalog=catalog, notes=notes, workspace=ws)
    outcomes: list[Any] = await asyncio.gather(
        asyncio.wait_for(pricing_team(ctx), timeout),
        asyncio.wait_for(quote_team(ctx), timeout),
        return_exceptions=True,
    )
    pricing_result, quote_result = outcomes
    failed: list[str] = []
    problems: list[str] = []
    for team, outcome in (("pricing", pricing_result), ("quote", quote_result)):
        if isinstance(outcome, BaseException):
            failed.append(team)
            # Only the category is kept. The exception text may contain model output.
            ws.event(team, "failed", error=type(outcome).__name__)
    if len(failed) == 2:
        return CrewResult(status="failed", failed_half="both", trace=ws.trace,
                          questions=["The crew could not finish either half. Please try again."])
    if failed:
        return CrewResult(status="failed", failed_half=failed[0], trace=ws.trace,
                          questions=[f"The {failed[0]} half did not finish. Please try again."])

    shell = quote_result["shell"]
    questions = list(shell["questions"])
    questions += [f"What should {row['name']} cost, or should it be excluded? ({row['reason']})"
                  for row in pricing_result["missing"]]
    if pricing_result["missing"] or not pricing_result["items"]:
        # Unpriced items are questions, not guesses. No draft is built until the contractor answers.
        ws.event("join", "skipped", reason="needs_input")
        return CrewResult(status="needs_input", items=pricing_result["items"], missing=pricing_result["missing"],
                          questions=questions, trace=ws.trace)

    problems = join(pricing_result, quote_result)
    ws.event("join", "checked", problems=len(problems))
    if problems:
        return CrewResult(status="failed", trace=ws.trace, problems=problems,
                          questions=["The pricing and the scope disagree. Please check the job notes and try again."])
    customer_text = {"lines_text": quote_result["writer"]["lines_text"],
                     "total_text": quote_result["writer"]["total_text"],
                     "scope_text": shell["scope_text"], "assumptions": shell["assumptions"],
                     "exclusions": shell["exclusions"]}
    return CrewResult(status="ready", items=pricing_result["items"], questions=questions,
                      customer_text=customer_text, trace=ws.trace)
