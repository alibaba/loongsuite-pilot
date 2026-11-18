import json
import os
import subprocess
import sys

from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags, TraceState
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

node, fixture, data_dir, session_id, request_id, trace_id, parent_span_id = sys.argv[1:]
span_context = SpanContext(
    trace_id=int(trace_id, 16),
    span_id=int(parent_span_id, 16),
    is_remote=False,
    trace_flags=TraceFlags(TraceFlags.SAMPLED),
    trace_state=TraceState([("poc", "python")]),
)
carrier = {}
with trace.use_span(NonRecordingSpan(span_context), end_on_exit=False):
    TraceContextTextMapPropagator().inject(carrier)

environment = {
    key: value for key, value in os.environ.items()
    if key.lower() not in ("traceparent", "tracestate")
}
environment.update({
    "TRACEPARENT": carrier["traceparent"],
    "TRACESTATE": carrier["tracestate"],
    "POC_DATA_DIR": data_dir,
    "POC_SESSION_ID": session_id,
    "POC_REQUEST_ID": request_id,
})
result = subprocess.run(
    [node, fixture], input="same fixture prompt", text=True,
    capture_output=True, check=True, timeout=10, env=environment,
)
print(json.dumps(json.loads(result.stdout)))
