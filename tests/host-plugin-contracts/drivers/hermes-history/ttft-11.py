
scenario = __SCENARIO_JSON__
if scenario == "old-signature":
    def old_method(self, api_kwargs):
        return "old-result"
    AIAgent._interruptible_streaming_api_call = old_method
if scenario == "missing-module":
    del sys.modules["run_agent"]
if scenario == "missing-pre":
    # Install the bridge on a different completed request first.
    begin("previous")
    end("previous")
    ctx.hooks["pre_llm_call"](session_id="test", user_message="fixture")
else:
    begin("test")
if scenario == "old-signature":
    extra["result"] = AIAgent("test")._interruptible_streaming_api_call({})
else:
    agent = AIAgent("other" if scenario == "wrong-session" else "test",
                    "responses" if scenario == "unsupported-mode" else "chat_completions")
    extra["result"] = agent._interruptible_streaming_api_call({"delta_times": [180]}, on_first_delta=lambda: "preserved")
end("test")
flush("test")
