//! Optional Agent-host test bridge; never invoked by the default Cargo suite.
//! Build first, then provide PILOT_NATIVE_PROJECTION_BRIDGE to test:host:mimo/pi.
use loongsuite_pilot::flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::json;
use std::io::{Read, Write};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut payload = Vec::new();
    std::io::stdin()
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut payload)?;
    if payload.len() > 8 * 1024 * 1024 {
        return Err("host test input exceeds 8 MiB".into());
    }
    let records: Vec<AgentActivityEntry> = serde_json::from_slice(&payload)?;
    let converted = GenAiEventLogConverter.convert(&records, &ConvertOptions::default())?;
    let spans = converted
        .spans
        .into_iter()
        .map(|span| {
            json!({
                "name":span.name,"traceId":span.trace_id,"spanId":span.span_id,
                "parentSpanId":span.parent_span_id,"attributes":span.attributes,
                "startTime":span.start_time,"endTime":span.end_time,"duration":span.duration,
            })
        })
        .collect::<Vec<_>>();
    let result = json!({"spans":spans,"warnings":converted.warnings,"traceIds":converted.trace_ids,"spanCount":converted.span_count});
    serde_json::to_writer(std::io::stdout().lock(), &result)?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}
