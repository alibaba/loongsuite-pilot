"""Read-only observer of actual QwenPaw runtime and AgentScope callbacks."""
import inspect
import json
import os
import time
from pathlib import Path

from agentscope.middleware import MiddlewareBase
from qwenpaw.runtime.hooks import HookBase, HookResult
from qwenpaw.runtime.phases import Phase


def write(kind, session, **fields):
    path = Path(os.environ["PARITY_CONTRACT_LOG"])
    with path.open("a") as output:
        output.write(json.dumps({"kind": kind, "session_id": session,
                                 "time_ns": time.time_ns(), **fields}, default=str) + "\n")


class RequestHook(HookBase):
    name = "parity_contract_request"
    phase = Phase.PRE_DISPATCH
    priority = -1000

    async def run(self, ctx):
        write("request", ctx.session_id, agent_id=ctx.agent_id)
        return HookResult()


class ModelModeHook(HookBase):
    name = "parity_model_mode"
    phase = Phase.POST_AGENT_BUILD
    priority = 9999

    async def run(self, ctx):
        # Test scenario configuration: use the real model/provider in both modes.
        model = ctx.agent.model
        seen = set()
        while model is not None and id(model) not in seen:
            seen.add(id(model))
            model.stream = getattr(ctx.request, "stream", True)
            model = getattr(model, "_model", getattr(model, "_inner", None))
        return HookResult()


class Observer(MiddlewareBase):
    def __init__(self, ctx):
        self.session = ctx.session_id

    async def on_model_call(self, agent, input_kwargs, next_handler):
        write("model_start", self.session,
              model=getattr(input_kwargs.get("current_model"), "model", None),
              input_count=len(input_kwargs.get("messages", [])),
              streaming=getattr(input_kwargs.get("current_model"), "stream", None))
        result = await next_handler(**input_kwargs)
        if inspect.isasyncgen(result):
            async def consume():
                last = None
                async for chunk in result:
                    last = chunk
                    yield chunk
                write("model_end", self.session, usage=getattr(last, "usage", None))
            return consume()
        write("model_end", self.session, usage=getattr(result, "usage", None))
        return result

    async def on_acting(self, agent, input_kwargs, next_handler):
        call = input_kwargs["tool_call"]
        write("tool_start", self.session, tool=getattr(call, "name", None),
              tool_call_id=getattr(call, "id", None))
        try:
            async for item in next_handler(**input_kwargs):
                yield item
        finally:
            write("tool_end", self.session, tool_call_id=getattr(call, "id", None))


class Plugin:
    def register(self, api):
        api.register_runtime_hook(RequestHook())
        api.register_runtime_hook(ModelModeHook())
        api.register_middleware(lambda ctx, config: Observer(ctx), priority=1000)


plugin = Plugin()
