"""Typed handoff schemas. Anything that does not validate fails the team loudly; nothing is guessed."""
import json
from typing import Annotated, Literal, TypeVar

from pydantic import BaseModel, Field, StringConstraints, ValidationError

TRADES = ("plumbing", "electrical", "general")
Short = Annotated[str, StringConstraints(min_length=1, max_length=200)]
Label = Annotated[str, StringConstraints(min_length=1, max_length=120)]
Unit = Literal["ea", "ft", "lf", "in", "sf", "sy", "yd", "m", "lb", "gal", "box", "roll", "bag", "hr", "set", "pair", "pc", "each"]


class ContractError(Exception):
    pass


class PlannedItem(BaseModel):
    trade: Literal["plumbing", "electrical", "general"]
    name: Label
    quantity: float = Field(gt=0, le=10000)
    unit: Unit
    labor_hours_per_unit: float = Field(default=0, ge=0, le=500)
    waste_pct: float = Field(default=0, ge=0, le=1)


class PricingPlan(BaseModel):
    items: list[PlannedItem] = Field(default_factory=list, max_length=60)


class MatchChoice(BaseModel):
    index: int = Field(ge=0, le=1000)
    price_item_id: str | None = Field(default=None, max_length=64)


class EstimatorChoice(BaseModel):
    matches: list[MatchChoice] = Field(default_factory=list, max_length=60)


class QuoteShell(BaseModel):
    scope_text: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    assumptions: list[Short] = Field(default_factory=list, max_length=10)
    exclusions: list[Short] = Field(default_factory=list, max_length=10)
    line_labels: list[Label] = Field(min_length=1, max_length=60)
    questions: list[Short] = Field(default_factory=list, max_length=5)


class WriterOut(BaseModel):
    lines_text: list[Annotated[str, StringConstraints(min_length=1, max_length=200)]] = Field(min_length=1, max_length=60)
    total_text: Annotated[str, StringConstraints(min_length=1, max_length=200)]


M = TypeVar("M", bound=BaseModel)


def parse(raw: str, model: type[M]) -> M:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ContractError(f"{model.__name__}: no JSON object in output")
    try:
        return model.model_validate(json.loads(text[start:end + 1]))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise ContractError(f"{model.__name__}: output failed the contract") from exc
