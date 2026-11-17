use super::abi::{OnHook, PilotJsonView, OK};
use super::agent_hooks::AgentHook;
use super::hook_protocol::*;
use super::outbox::Outbox;
use crate::interceptor::{
    build_interceptor_config_with, resolve_enabled_rule_ids,
    rules::{builtin_rules, RuleEngine},
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
        for channel in ["cloud", "local", "observe"] {
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
                            record_tool_verdict(&queue, &settings, &result, if channel == "local" { callback } else { None }, context, deadline);
                            let response=json!({"id":packet.id,"instance":instance,"action":result.0,"reason":result.1});
                            if let Ok(bytes)=serde_json::to_vec(&response){if bytes.len()<=MAX_REPLY && Instant::now()<deadline && socket.send_to(&bytes,peer).is_ok(){record_blocked_prompt(&queue,&settings,&result);}}
                        }
                        if channel == "observe" { return; }
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
    let Some(adapter) = AgentHook::for_wire_id(&packet.agent) else {
        return allow();
    };
    if !trusted
        .get("agents")
        .and_then(Value::as_array)
        .is_some_and(|agents| agents.iter().any(|a| a == adapter.policy_id()))
    {
        return allow();
    }

    let accepted = adapter.wakeup(&payload, &packet.event, channel, &trusted, queue);
    if channel == "observe" {
        if accepted && packet.event != "SubagentStop" && trusted["relay_host_verdicts"] == true {
            let session = payload
                .get("session_id")
                .or_else(|| payload.get("conversation_id"))
                .and_then(Value::as_str);
            let traceparent = payload
                .get(QODER_OBSERVE_CONTEXT)
                .and_then(|value| value["TRACEPARENT"].as_str());
            if let (Some(callback), Some(session), Some(traceparent)) =
                (callback, session, traceparent)
            {
                notify_shell(
                    queue,
                    callback,
                    context,
                    deadline,
                    json!({
                        "kind": "qoder_upstream",
                        "session_id": session,
                        "traceparent": traceparent,
                    }),
                );
            }
        }
        return allow();
    }

    let blocking = adapter.supports_blocking(&packet.event)
        && trusted
            .get("sync_wait_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        && trusted
            .get("blocking_agents")
            .and_then(Value::as_array)
            .is_none_or(|list| list.iter().any(|a| a == &packet.agent));
    let request = adapter.parse(&payload, &packet.event);
    let verdict = if channel == "cloud" {
        let Some(callback) = callback else {
            return allow();
        };
        let mut normalized = payload.clone();
        if let Some(request) = request.as_ref() {
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
        let Some(request) = request.as_ref() else {
            return allow();
        };
        let config = build_interceptor_config_with(trusted.get("local"), |_| None);
        let engine = RuleEngine::new(builtin_rules(), resolve_enabled_rule_ids(&config));
        serde_json::to_value(engine.evaluate(request)).unwrap_or_else(|_| json!({"action":"allow"}))
    };
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

fn record_tool_verdict(
    queue: &Outbox,
    settings: &RwLock<Value>,
    result: &(&str, String, Option<crate::interceptor::HookRequest>),
    callback: Option<OnHook>,
    context: usize,
    deadline: Instant,
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
        if let Some(callback) =
            callback.filter(|_| settings.read().unwrap()["relay_host_verdicts"] == true)
        {
            let verdict = json!({
                "session_id": key.session_id,
                "tool_use_id": key.tool_use_id,
                "phase": phase,
                "action": action,
            });
            notify_shell(queue, callback, context, deadline, verdict);
        }
    }
}

fn notify_shell(queue: &Outbox, callback: OnHook, context: usize, deadline: Instant, row: Value) {
    let Ok(bytes) = serde_json::to_vec(&row) else {
        return;
    };
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u32;
    if remaining == 0 {
        return;
    }
    queue.callbacks.fetch_add(1, Ordering::SeqCst);
    let mut reply = [0; 1];
    let mut length = 0;
    // SAFETY: all buffers remain valid until the host callback returns.
    unsafe {
        callback(
            context as *mut _,
            PilotJsonView::from_bytes(&bytes),
            remaining,
            reply.as_mut_ptr(),
            reply.len(),
            &mut length,
        );
    }
    queue.callbacks.fetch_sub(1, Ordering::SeqCst);
}

fn record_blocked_prompt(
    queue: &Outbox,
    settings: &RwLock<Value>,
    result: &(&str, String, Option<crate::interceptor::HookRequest>),
) {
    use crate::interceptor::HookEventName;
    let Some(request) = result.2.as_ref() else {
        return;
    };
    if result.0 == "block"
        && matches!(
            request.agent,
            crate::interceptor::InterceptorAgent::Qoder
                | crate::interceptor::InterceptorAgent::QoderCli
        )
        && request.event == HookEventName::UserPromptSubmit
    {
        let mut entry = crate::interceptor::build_blocked_qoder_prompt_entry(request, None);
        let (host, mask) = {
            let settings = settings.read().unwrap();
            entry.user_id = settings["user_id"].as_str().unwrap_or("").to_owned();
            (
                settings
                    .pointer("/collector_plans/qoder/pilot_host")
                    .cloned(),
                settings["mask"].clone(),
            )
        };
        if let Some(host) = host
            .and_then(|state| serde_json::from_value::<super::policy::PilotHostState>(state).ok())
        {
            let Ok(mut workspace) = crate::core::WorkspacePolicy::new(
                &host.exclude_workspaces,
                Some(
                    host.data_dir
                        .join("state/workspace-exclusions")
                        .to_string_lossy()
                        .into_owned(),
                ),
            ) else {
                return;
            };
            if !workspace.allows(
                &crate::normalization::entry_to_object(&entry),
                "interceptor",
            ) {
                return;
            }
            if host.capture_message_content == Some(false) {
                crate::normalization::agent_content_policy::strip_agent_message_content(&mut entry);
            }
        }
        let mask = serde_json::from_value::<crate::types::MaskConfig>(mask).ok();
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
