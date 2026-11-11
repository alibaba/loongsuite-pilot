use super::abi::{OnHook, PilotJsonView, OK};
use super::hook_protocol::*;
use super::outbox::Outbox;
use crate::interceptor::{
    adapters::parse_hook_request,
    build_interceptor_config_with, resolve_enabled_rule_ids,
    rules::{builtin_rules, RuleEngine},
    InterceptorAgent,
};
use serde_json::{json, Value};
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub struct Hooks {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    workers: Vec<Arc<Mutex<Vec<JoinHandle<()>>>>>,
    descriptors: Vec<PathBuf>,
    pub settings: Arc<RwLock<Value>>,
    instance: String,
}
impl Hooks {
    pub fn start(
        root: &Path,
        queue: Arc<Outbox>,
        settings: Value,
        callback: Option<OnHook>,
        context: usize,
        stop: Arc<AtomicBool>,
        activated: Arc<AtomicBool>,
    ) -> anyhow::Result<Self> {
        let workers = Vec::new();
        let instance = uuid::Uuid::new_v4().to_string();
        let settings = Arc::new(RwLock::new(settings));
        let root = root.to_owned();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        }
        let mut hooks = Self {
            stop: stop.clone(),
            threads: Vec::new(),
            workers,
            descriptors: Vec::new(),
            settings: settings.clone(),
            instance: instance.clone(),
        };
        for channel in ["cloud", "local"] {
            let workers = Arc::new(Mutex::new(Vec::new()));
            hooks.workers.push(workers.clone());
            let spool = root.join(format!("hook-requests-{channel}"));
            crate::utils::source_access::private_path(&spool)?;
            std::fs::create_dir_all(&spool)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&spool, std::fs::Permissions::from_mode(0o700))?;
            }

            let socket = Arc::new(UdpSocket::bind("127.0.0.1:0")?);
            socket.set_read_timeout(Some(Duration::from_millis(100)))?;
            let descriptor = Descriptor {
                schema: 2,
                pid: std::process::id(),
                port: socket.local_addr()?.port(),
                token: format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                ),
                instance: instance.clone(),
                request_receipts: true,
            };
            let path = root.join(format!("sdk-hooks-{channel}.json"));
            atomic_descriptor(&path, &descriptor)?;
            hooks.descriptors.push(path);
            let (settings, queue, stop, workers, spool) = (
                settings.clone(),
                queue.clone(),
                stop.clone(),
                workers.clone(),
                spool.clone(),
            );
            let activated = activated.clone();
            hooks.threads.push(std::thread::Builder::new().name(format!("pilot-hook-{channel}")).spawn(move||{
                let mut buffer=[0u8;4096];
                let mut seen=std::collections::HashMap::<String,Instant>::new();
                while !stop.load(Ordering::SeqCst){
                    if !activated.load(Ordering::SeqCst) {std::thread::sleep(Duration::from_millis(5));continue;}
                    let (len,peer)=match socket.recv_from(&mut buffer){Ok(value)=>value,Err(_)=>continue};
                    if !peer.ip().is_loopback(){continue;}
                    let packet=match serde_json::from_slice::<Datagram>(&buffer[..len]){Ok(p)=>p,Err(_)=>continue};
                    if packet.schema!=2 || !constant_time_eq(packet.token.as_bytes(),descriptor.token.as_bytes()) || packet.id.len()!=40 || !packet.id.bytes().all(|b|b.is_ascii_hexdigit()) || packet.length>MAX_REQUEST || packet.remaining_ms==0{continue;}
                    seen.retain(|_,t|t.elapsed()<Duration::from_secs(5));
                    if seen.contains_key(&packet.id) || seen.len() >= 1024 { continue; }
                    seen.insert(packet.id.clone(),Instant::now());
                    let age=(chrono::Utc::now().timestamp_millis().max(0) as u64).saturating_sub(packet.t0_unix_ms);
                    let remaining=(packet.remaining_ms as u64).min(DEADLINE_MS.saturating_sub(age));
                    if remaining==0 { continue; }
                    let deadline=Instant::now()+Duration::from_millis(remaining);
                    let mut running=workers.lock().unwrap();
                    let mut index=0;while index<running.len(){if running[index].is_finished(){let thread=running.swap_remove(index);let _=thread.join();}else{index+=1;}}
                    if running.len()>=8{queue.alarm("SDK_HOOK_BUSY","hook concurrency exhausted; bin will fail open");continue;}
                    if packet.want_receipt {
                        let receipt = json!({
                            "id": packet.id,
                            "instance": descriptor.instance,
                            "received": true,
                        });
                        if serde_json::to_vec(&receipt)
                            .ok()
                            .and_then(|bytes| socket.send_to(&bytes, peer).ok())
                            .is_none()
                        {
                            continue;
                        }
                    }
                    let (socket,queue,settings,spool,instance,stop)=(socket.clone(),queue.clone(),settings.clone(),spool.clone(),descriptor.instance.clone(),stop.clone());
                    if let Ok(thread)=std::thread::Builder::new().name("pilot-hook-verdict".into()).spawn(move||{
                        let scope=crate::utils::source_access::SourceScope::new(Vec::new(),0,0);
                        if let Some(root)=spool.parent(){scope.set_log(root.join("hook.log"));}
                        crate::utils::source_access::install(Some(scope));
                        let hook_started=Instant::now();
                        let result=process(&packet,&spool,channel,&settings,callback,(context,&queue),deadline);
                        queue.record_hook(&packet.agent, &format!("{channel}:{}",packet.event),hook_started.elapsed().as_secs_f64()*1000.0);
                        if Instant::now()<deadline && !stop.load(Ordering::SeqCst){
                            let response=json!({"id":packet.id,"instance":instance,"action":result.0,"reason":result.1});
                            if let Ok(bytes)=serde_json::to_vec(&response){if bytes.len()<=MAX_REPLY && socket.send_to(&bytes,peer).is_ok(){record_native_verdict(&queue,&settings,&result);}}
                        }
                        // Record delivery is independent of the Agent verdict.
                        let activity=json!({"event.id":uuid::Uuid::new_v4().to_string(),"event.name":"other","time_unix_nano":chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0).to_string(),"gen_ai.agent.type":packet.agent,"gen_ai.session.id":result.2.as_ref().and_then(|r|r.session_id.as_deref()).unwrap_or(""),"gen_ai.provider.name":"pilot","event.kind":"interceptor.result","hook.channel":channel,"hook.request_id":packet.id,"hook.action":result.0,"hook.reason":result.1,"hook.late":Instant::now()>=deadline});
                        let mut activity=activity;
                        activity["version"]=json!(env!("CARGO_PKG_VERSION"));
                        activity["user.id"]=queue.identity.read().unwrap()["user_id"].clone();
                        if let Err(error)=queue.enqueue_hook(&activity.to_string().into_bytes()){queue.alarm("SDK_HOOK_RECORD_FULL",&error.to_string());}
                    }){running.push(thread);}
                }
            })?);
        }
        Ok(hooks)
    }
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
        for workers in &self.workers {
            for thread in workers.lock().unwrap().drain(..) {
                let _ = thread.join();
            }
        }
        for path in &self.descriptors {
            if std::fs::read(path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Descriptor>(&b).ok())
                .is_some_and(|d| d.instance == self.instance)
            {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}
impl Drop for Hooks {
    fn drop(&mut self) {
        self.stop();
    }
}

fn atomic_descriptor(path: &Path, descriptor: &Descriptor) -> anyhow::Result<()> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| anyhow::anyhow!("descriptor parent"))?,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(&serde_json::to_vec(descriptor)?)?;
    file.persist(path)?;
    Ok(())
}
fn process(
    packet: &Datagram,
    spool: &Path,
    channel: &str,
    settings: &RwLock<Value>,
    callback: Option<OnHook>,
    callback_context: (usize, &Outbox),
    deadline: Instant,
) -> (
    &'static str,
    String,
    Option<crate::interceptor::HookRequest>,
) {
    let (context, queue) = callback_context;
    let allow = || ("allow", String::new(), None);
    let path = spool.join(&packet.id);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(_) => return allow(),
    };
    if !metadata.is_file()
        || metadata.len() as usize != packet.length
        || metadata.file_type().is_symlink()
    {
        return allow();
    }
    let bytes = (|| -> std::io::Result<Vec<u8>> {
        use std::io::Read;
        let file = crate::utils::source_access::open_under(&path, spool)?;
        let mut body = Vec::new();
        file.take((MAX_REQUEST + 1) as u64).read_to_end(&mut body)?;
        Ok(body)
    })();
    let body = match bytes {
        Ok(bytes) if bytes.len() <= MAX_REQUEST => bytes,
        _ => return allow(),
    };
    let _ = std::fs::remove_file(path);
    let payload = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(object)) => object,
        _ => return allow(),
    };
    let trusted = settings.read().unwrap().clone();
    let agent_alias = if packet.agent == "qodercli" {
        "qoder"
    } else {
        packet.agent.as_str()
    };
    if !trusted
        .get("agents")
        .and_then(Value::as_array)
        .is_some_and(|agents| agents.iter().any(|a| a == agent_alias))
    {
        return allow();
    }

    publish_authorized_wakeup(&packet.agent, &payload, &trusted, queue);
    let blocking = matches!(
        packet.event.as_str(),
        "PreToolUse" | "PostToolUse" | "UserPromptSubmit"
    ) && trusted
        .get("sync_wait_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
        && matches!(packet.agent.as_str(), "qoder" | "qodercli")
        && trusted
            .get("blocking_agents")
            .and_then(Value::as_array)
            .map(|list| list.iter().any(|a| a == &packet.agent))
            .unwrap_or(true);
    let verdict = if channel == "cloud" {
        let Some(callback) = callback else {
            return allow();
        };
        let mut normalized = payload.clone();
        let parsed = InterceptorAgent::parse(&packet.agent)
            .and_then(|agent| parse_hook_request(&payload, agent, Some(&packet.event)));
        if let Some(request) = parsed {
            normalized.insert("session_id".into(), json!(request.session_id));
            normalized.insert("tool_name".into(), json!(request.tool_name));
            normalized.insert("tool_input".into(), json!(request.tool_input));
            normalized.insert("prompt_text".into(), json!(request.prompt));
            normalized.insert("response_text".into(), json!(request.tool_response));
            normalized.insert("cwd".into(), json!(request.cwd));
        }
        if let Some(command) = normalized
            .get("tool_input")
            .and_then(|i| i.get("command"))
            .cloned()
        {
            normalized.insert("command".into(), command);
        }
        if let Some(path) = normalized
            .get("tool_input")
            .and_then(|i| i.get("file_path").or_else(|| i.get("path")))
            .cloned()
        {
            normalized.insert("file_path".into(), path);
        }
        normalized.insert("t0_unix_ms".into(), json!(packet.t0_unix_ms));
        normalized.insert("trace_id".into(), json!(packet.id));
        normalized.insert("client_event_id".into(), json!(packet.id));
        normalized.insert("agent".into(), json!(packet.agent));
        normalized.insert("event".into(), json!(packet.event));
        normalized.insert("supports_blocking".into(), json!(blocking));
        normalized.insert("truncated".into(), json!(false));
        let request = match serde_json::to_vec(&normalized) {
            Ok(bytes) => bytes,
            Err(_) => return allow(),
        };
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u32;
        if remaining == 0 {
            return allow();
        }
        let mut reply = vec![0u8; MAX_REPLY];
        let mut length = 0usize;
        queue.callbacks.fetch_add(1, Ordering::SeqCst);
        // SAFETY: SDK-owned input/output buffers and host-retained context. No
        // collector, policy, or queue lock is held during external code.
        let result = unsafe {
            callback(
                context as *mut _,
                PilotJsonView::from_bytes(&request),
                remaining,
                reply.as_mut_ptr(),
                reply.len(),
                &mut length,
            )
        };
        queue.callbacks.fetch_sub(1, Ordering::SeqCst);
        if result != OK || length > reply.len() || Instant::now() >= deadline {
            return allow();
        }
        match serde_json::from_slice::<Value>(&reply[..length]) {
            Ok(value) => value,
            Err(_) => return allow(),
        }
    } else {
        let Some(agent) = InterceptorAgent::parse(&packet.agent) else {
            return allow();
        };
        let Some(request) = parse_hook_request(&payload, agent, Some(&packet.event)) else {
            return allow();
        };
        let config = build_interceptor_config_with(trusted.get("local"), |_| None);
        let engine = RuleEngine::new(builtin_rules(), resolve_enabled_rule_ids(&config));
        serde_json::to_value(engine.evaluate(&request))
            .unwrap_or_else(|_| json!({"action":"allow"}))
    };
    let request = InterceptorAgent::parse(&packet.agent)
        .and_then(|agent| parse_hook_request(&payload, agent, Some(&packet.event)));
    match reply_action(&verdict) {
        Some(("block", reason)) if blocking => {
            ("block", reason.chars().take(512).collect(), request)
        }
        Some(("allow", _)) => ("allow", String::new(), request),
        _ => allow(),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

/// Publish only metadata through Qoder's existing wakeup protocol. Its existing
/// collector remains the sole transcript parser and progress owner.
fn publish_authorized_wakeup(
    agent: &str,
    payload: &serde_json::Map<String, Value>,
    settings: &Value,
    queue: &Outbox,
) {
    if !matches!(agent, "qoder" | "qodercli") {
        return;
    }
    let Some(plan) = settings.pointer("/collector_plans/qoder") else {
        return;
    };
    let Some(data) = settings.get("data_dir").and_then(Value::as_str) else {
        return;
    };
    let Some(path) = payload
        .get("transcript_path")
        .or_else(|| payload.get("transcriptPath"))
        .and_then(Value::as_str)
    else {
        return;
    };
    let path = match super::policy::canonical_candidate(Path::new(path)) {
        Ok(path) => path,
        Err(_) => return,
    };
    let sources = plan
        .get("sources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let roots: Vec<PathBuf> = sources
        .iter()
        .filter(|s| s["kind"] == "transcript")
        .filter_map(|s| s["path"].as_str().map(PathBuf::from))
        .collect();
    if roots.is_empty() {
        return;
    }
    let authorized = path.is_absolute() && roots.iter().any(|root| path.starts_with(root));
    let scope = crate::utils::source_access::SourceScope::new(roots, 1, MAX_REQUEST);
    // UserPromptSubmit can precede file creation. Authorize the resolved
    // missing leaf and publish the existing zero-size native wakeup; actual
    // transcript reads still validate their opened file later.
    if !authorized || (path.exists() && scope.check(&path).is_err()) {
        queue.alarm(
            "SDK_HOOK_SOURCE_DENIED",
            "Qoder hook transcript is outside the authorized source",
        );
        return;
    }
    let namespace = {
        use sha2::{Digest, Sha256};
        let bytes = serde_json::to_vec(&(
            plan["agent"].clone(),
            plan["profile"].clone(),
            plan["sources"].clone(),
            plan["allowed_roots"].clone(),
        ))
        .expect("validated source plan");
        hex::encode(Sha256::digest(bytes))
    };
    let state = Path::new(data).join("sources").join(namespace);
    if crate::utils::source_access::private_path(&state).is_err() {
        return;
    }
    let mut value = Value::Object(payload.clone());
    value["transcript_path"] = json!(path);
    if !crate::hook_process::publish_qoder_wakeup(
        &value,
        &state,
        "qoder",
        None,
        &serde_json::Map::new(),
        &serde_json::Map::new(),
    ) {
        queue.alarm(
            "SDK_HOOK_WAKEUP",
            "Qoder wakeup was not accepted; source progress retained",
        );
    }
}

fn record_native_verdict(
    queue: &Outbox,
    settings: &RwLock<Value>,
    result: &(&str, String, Option<crate::interceptor::HookRequest>),
) {
    use crate::interceptor::{
        HookEventName, ToolInterceptPhase, ToolVerdictAction, ToolVerdictKey,
    };
    let Some(request) = result.2.as_ref() else {
        return;
    };
    let phase = match request.event {
        HookEventName::PreToolUse => Some(ToolInterceptPhase::PreToolUse),
        HookEventName::PostToolUse => Some(ToolInterceptPhase::PostToolUse),
        _ => None,
    };
    if let Some((phase, tool_use_id)) =
        phase.zip(request.tool_use_id.as_ref().filter(|s| !s.is_empty()))
    {
        let key = ToolVerdictKey {
            session_id: request.session_id.clone(),
            tool_use_id: tool_use_id.clone(),
            phase,
        };
        let now = chrono::Utc::now().timestamp_millis();
        let action = if result.0 == "block" {
            ToolVerdictAction::Block
        } else {
            ToolVerdictAction::Allow
        };
        // Both independent chains may decide the same tool operation. Retain a
        // block when its peer later allows; one allow cannot erase a block.
        if queue.verdicts.get(&key, now) != Some(ToolVerdictAction::Block) {
            queue.verdicts.put(&key, action, now);
        }
    }
    if result.0 == "block" && request.event == HookEventName::UserPromptSubmit {
        let mut entry = crate::interceptor::build_blocked_qoder_prompt_entry(request, None);
        entry.user_id = settings
            .read()
            .unwrap()
            .get("user_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let mask = settings
            .read()
            .unwrap()
            .get("mask")
            .cloned()
            .and_then(|v| serde_json::from_value::<crate::types::MaskConfig>(v).ok());
        let entry = mask
            .as_ref()
            .map(|mask| {
                crate::mask::mask_agent_activity_entry(&entry, mask, None, None).into_owned()
            })
            .unwrap_or(entry);
        if let Ok(bytes) = serde_json::to_vec(&entry) {
            if let Err(error) = queue.enqueue_hook(&bytes) {
                queue.alarm("SDK_BLOCKED_PROMPT_QUEUE", &error.to_string());
            }
        }
    }
}
