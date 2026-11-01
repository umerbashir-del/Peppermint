"""LLM gateway. One OpenAI-compatible endpoint; the model for each slot comes from config, not code."""
import os
from dataclasses import dataclass
from typing import Protocol

import httpx


class LLMError(Exception):
    pass


class BudgetExceeded(LLMError):
    pass


class NotConfigured(LLMError):
    pass


@dataclass
class Budget:
    max_usd: float
    max_turns: int
    spent: float = 0.0
    turns: int = 0

    def charge_turn(self) -> None:
        self.turns += 1
        if self.turns > self.max_turns:
            raise BudgetExceeded("turn limit reached")

    def charge_cost(self, usd: float) -> None:
        self.spent += usd
        if self.spent > self.max_usd:
            raise BudgetExceeded("dollar limit reached")


class Gateway(Protocol):
    async def complete(self, slot: str, prompt_name: str, system: str, user: str, budget: Budget) -> str: ...


class OpenAICompatibleGateway:
    def __init__(self, base_url: str, api_key: str, models: dict[str, str], price_in: float, price_out: float,
                 timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.models = models
        self.price_in = price_in
        self.price_out = price_out
        self.timeout = timeout

    async def complete(self, slot: str, prompt_name: str, system: str, user: str, budget: Budget) -> str:
        budget.charge_turn()
        payload = {"model": self.models[slot], "temperature": 0,
                   "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(f"{self.base_url}/chat/completions", json=payload,
                                             headers={"Authorization": f"Bearer {self.api_key}"})
        except httpx.HTTPError as exc:
            raise LLMError("gateway unreachable") from exc
        if response.status_code != 200:
            # Never include the response body: it can echo request content or credentials.
            raise LLMError(f"gateway returned status {response.status_code}")
        data = response.json()
        usage = data.get("usage") or {}
        budget.charge_cost(usage.get("prompt_tokens", 0) * self.price_in / 1e6
                           + usage.get("completion_tokens", 0) * self.price_out / 1e6)
        return data["choices"][0]["message"]["content"]


def gateway_from_env() -> Gateway:
    base = os.getenv("QBC_LLM_BASE_URL")
    key = os.getenv("QBC_LLM_API_KEY")
    models = {slot: os.getenv(f"QBC_MODEL_{slot.upper()}") for slot in ("strong", "mid", "small")}
    if not base or not key or not all(models.values()):
        raise NotConfigured("LLM gateway is not configured (QBC_LLM_BASE_URL, QBC_LLM_API_KEY, QBC_MODEL_STRONG/MID/SMALL)")
    return OpenAICompatibleGateway(
        base, key, {k: v for k, v in models.items() if v},
        price_in=float(os.getenv("QBC_PRICE_IN_PER_MTOK", "0")),
        price_out=float(os.getenv("QBC_PRICE_OUT_PER_MTOK", "0")),
        timeout=float(os.getenv("QBC_LLM_TIMEOUT_SECONDS", "60")),
    )
