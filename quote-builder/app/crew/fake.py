"""Scripted gateway for tests and offline development. Never used when a real gateway is configured."""
import asyncio
from collections.abc import Callable

from app.crew.llm import Budget


class FakeGateway:
    def __init__(self, responder: Callable[[str, str], str], delay: float = 0.0):
        self.responder = responder
        self.delay = delay
        self.calls: list[str] = []

    async def complete(self, slot: str, prompt_name: str, system: str, user: str, budget: Budget) -> str:
        budget.charge_turn()
        if self.delay:
            await asyncio.sleep(self.delay)
        self.calls.append(prompt_name)
        return self.responder(prompt_name, user)
