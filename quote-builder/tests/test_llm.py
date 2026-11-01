import asyncio
import json

import httpx
import pytest

from app.crew import llm
from app.crew.llm import Budget, BudgetExceeded, LLMError, NotConfigured, OpenAICompatibleGateway, gateway_from_env


def _gateway_with(handler):
    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    def factory(**kwargs):
        return original(transport=transport, **kwargs)

    return OpenAICompatibleGateway("https://gateway.test/v1/", "k-test", {"strong": "m1", "mid": "m2", "small": "m3"},
                                   price_in=1.0, price_out=2.0), factory


def test_success_returns_text_and_charges_cost(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["authorization"]
        seen["model"] = json.loads(request.content)["model"]
        return httpx.Response(200, json={"choices": [{"message": {"content": "{\"ok\": true}"}}],
                                         "usage": {"prompt_tokens": 1_000_000, "completion_tokens": 0}})

    gateway, factory = _gateway_with(handler)
    monkeypatch.setattr(llm.httpx, "AsyncClient", factory)
    budget = Budget(max_usd=5.0, max_turns=5)
    text = asyncio.run(gateway.complete("strong", "pricing_lead", "sys", "user", budget))
    assert text == "{\"ok\": true}"
    assert seen["auth"] == "Bearer k-test" and seen["model"] == "m1"
    assert budget.spent == pytest.approx(1.0) and budget.turns == 1


def test_error_status_does_not_echo_the_response_body(monkeypatch):
    gateway, factory = _gateway_with(lambda r: httpx.Response(500, text="echoed secret k-test"))
    monkeypatch.setattr(llm.httpx, "AsyncClient", factory)
    with pytest.raises(LLMError) as info:
        asyncio.run(gateway.complete("mid", "estimator", "s", "u", Budget(5.0, 5)))
    assert "500" in str(info.value) and "k-test" not in str(info.value)


def test_unreachable_gateway_is_an_llm_error(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("refused")

    gateway, factory = _gateway_with(handler)
    monkeypatch.setattr(llm.httpx, "AsyncClient", factory)
    with pytest.raises(LLMError, match="unreachable"):
        asyncio.run(gateway.complete("small", "writer", "s", "u", Budget(5.0, 5)))


def test_turn_budget_is_enforced_before_the_call(monkeypatch):
    gateway, factory = _gateway_with(lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "x"}}]}))
    monkeypatch.setattr(llm.httpx, "AsyncClient", factory)
    budget = Budget(max_usd=5.0, max_turns=0)
    with pytest.raises(BudgetExceeded):
        asyncio.run(gateway.complete("mid", "estimator", "s", "u", budget))


def test_gateway_from_env_requires_every_setting(monkeypatch):
    for name in ("QBC_LLM_BASE_URL", "QBC_LLM_API_KEY", "QBC_MODEL_STRONG", "QBC_MODEL_MID", "QBC_MODEL_SMALL"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(NotConfigured):
        gateway_from_env()
    monkeypatch.setenv("QBC_LLM_BASE_URL", "https://gateway.test/v1")
    monkeypatch.setenv("QBC_LLM_API_KEY", "k")
    monkeypatch.setenv("QBC_MODEL_STRONG", "a")
    monkeypatch.setenv("QBC_MODEL_MID", "b")
    with pytest.raises(NotConfigured):
        gateway_from_env()
    monkeypatch.setenv("QBC_MODEL_SMALL", "c")
    assert isinstance(gateway_from_env(), OpenAICompatibleGateway)
