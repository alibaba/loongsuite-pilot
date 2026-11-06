//! A persistent native worker for one trusted ESM span enricher.
//! Parent owns the existing CandidateChild process scope and five-second budget.
use boa_engine::builtins::promise::PromiseState;
use boa_engine::module::{ModuleLoader, ModuleRequest, Referrer};
use boa_engine::{
    js_string, Context, JsNativeError, JsObject, JsResult, JsString, JsValue, Module, Source,
};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;

const BRIDGE: &str = r#"
globalThis.__pilotEnrich = function(plugin, span, context) {
  for (const value of Object.values(span.attributes)) {
    if (Array.isArray(value)) Object.freeze(value);
  }
  Object.freeze(span.attributes);
  Object.freeze(span);
  Object.freeze(context);
  const patch = plugin.enrich(span, context);
  if (patch === undefined) return;
  if (patch && typeof patch.then === 'function') {
    Promise.resolve(patch).catch(() => {});
    throw new TypeError('enrich must be synchronous');
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('invalid patch');
  }
  const scalar = v => typeof v === 'string' || typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v));
  const updates = Object.create(null);
  for (const [key, value] of Object.entries(patch)) {
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new TypeError('invalid attribute');
    }
    if (!scalar(value)) {
      if (!Array.isArray(value)) throw new TypeError('invalid attribute');
      const values = value.filter(v => v !== null && v !== undefined);
      if (!values.every(v => scalar(v) && typeof v === typeof values[0])) {
        throw new TypeError('invalid attribute');
      }
    }
    updates[key] = Array.isArray(value) ? value.slice() : value;
  }
  return updates;
};
"#;

#[derive(Default)]
struct PilotModuleLoader {
    modules: RefCell<HashMap<PathBuf, Module>>,
}
impl PilotModuleLoader {
    fn resolve(referrer: &Referrer, specifier: &JsString) -> JsResult<PathBuf> {
        let specifier = specifier.to_std_string_escaped();
        let path = if specifier.starts_with("file:") {
            reqwest::Url::parse(&specifier)
                .ok()
                .and_then(|url| url.to_file_path().ok())
                .ok_or_else(|| JsNativeError::typ().with_message("Invalid file module URL"))?
        } else {
            let path = PathBuf::from(&specifier);
            if path.is_absolute() {
                path
            } else if specifier.starts_with("./") || specifier.starts_with("../") {
                referrer
                    .path()
                    .and_then(Path::parent)
                    .ok_or_else(|| JsNativeError::typ().with_message("Missing module referrer"))?
                    .join(path)
            } else {
                return Err(JsNativeError::typ()
                    .with_message("Unsupported host or package module")
                    .into());
            }
        };
        path.canonicalize().map_err(|_| {
            JsNativeError::typ()
                .with_message("Cannot resolve module")
                .into()
        })
    }
}
impl ModuleLoader for PilotModuleLoader {
    async fn load_imported_module(
        self: Rc<Self>,
        referrer: Referrer,
        request: ModuleRequest,
        context: &RefCell<&mut Context>,
    ) -> JsResult<Module> {
        let path = Self::resolve(&referrer, request.specifier())?;
        if let Some(module) = self.modules.borrow().get(&path).cloned() {
            return Ok(module);
        }
        let module = if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            if !request.attributes().iter().any(|attribute| {
                attribute.key() == &js_string!("type") && attribute.value() == &js_string!("json")
            }) {
                return Err(JsNativeError::typ()
                    .with_message("JSON import requires type json")
                    .into());
            }
            let content = std::fs::read_to_string(&path)
                .map_err(|_| JsNativeError::typ().with_message("Cannot read module"))?;
            Module::parse_json(JsString::from(content.as_str()), &mut context.borrow_mut())?
        } else {
            let source = Source::from_filepath(&path)
                .map_err(|_| JsNativeError::typ().with_message("Cannot read module"))?;
            Module::parse(source, None, &mut context.borrow_mut())?
        };
        self.modules.borrow_mut().insert(path, module.clone());
        Ok(module)
    }
    fn init_import_meta(self: Rc<Self>, object: &JsObject, module: &Module, context: &mut Context) {
        if let Some(path) = module.path() {
            if let Ok(url) = reqwest::Url::from_file_path(path) {
                let _ = object.create_data_property(
                    js_string!("url"),
                    JsString::from(url.as_str()),
                    context,
                );
            }
            let _ = object.create_data_property(
                js_string!("filename"),
                JsString::from(path.to_string_lossy().as_ref()),
                context,
            );
            if let Some(parent) = path.parent() {
                let _ = object.create_data_property(
                    js_string!("dirname"),
                    JsString::from(parent.to_string_lossy().as_ref()),
                    context,
                );
            }
        }
    }
}
struct Engine {
    context: Context,
    plugin: JsObject,
    bridge: JsObject,
}
impl Engine {
    fn load(path: &Path) -> JsResult<Self> {
        let path = path
            .canonicalize()
            .map_err(|_| JsNativeError::typ().with_message("Cannot resolve plugin"))?;
        let loader = Rc::new(PilotModuleLoader::default());
        let mut context = Context::builder().module_loader(loader.clone()).build()?;
        let source = Source::from_filepath(&path)
            .map_err(|_| JsNativeError::typ().with_message("Cannot read plugin"))?;
        let module = Module::parse(source, None, &mut context)?;
        loader.modules.borrow_mut().insert(path, module.clone());
        let promise = module.load_link_evaluate(&mut context);
        loop {
            context.run_jobs()?;
            match promise.state() {
                PromiseState::Fulfilled(_) => break,
                PromiseState::Rejected(_) => {
                    return Err(JsNativeError::typ()
                        .with_message("Cannot evaluate plugin")
                        .into())
                }
                PromiseState::Pending => std::thread::sleep(std::time::Duration::from_millis(1)),
            }
        }
        let plugin = module
            .get_value(js_string!("default"), &mut context)?
            .as_object()
            .ok_or_else(|| JsNativeError::typ().with_message("Expected default object"))?;
        if !plugin
            .get(js_string!("enrich"), &mut context)?
            .as_object()
            .is_some_and(|method| method.is_callable())
        {
            return Err(JsNativeError::typ()
                .with_message("Expected enrich method")
                .into());
        }
        context.eval(Source::from_bytes(BRIDGE))?;
        let bridge = context
            .global_object()
            .get(js_string!("__pilotEnrich"), &mut context)?
            .as_object()
            .ok_or_else(|| JsNativeError::typ().with_message("Cannot initialize bridge"))?;
        Ok(Self {
            context,
            plugin,
            bridge,
        })
    }
    fn enrich(&mut self, request: &Value) -> JsResult<Option<Value>> {
        let span = JsValue::from_json(&request["span"], &mut self.context)?;
        let context = JsValue::from_json(&request["context"], &mut self.context)?;
        let result = self.bridge.call(
            &JsValue::undefined(),
            &[self.plugin.clone().into(), span, context],
            &mut self.context,
        );
        // Consume rejected promises returned by unsupported async callbacks,
        // just as main's Promise.resolve(patch).catch(() => {}) does.
        self.context.run_jobs()?;
        result?.to_json(&mut self.context)
    }
}
fn write_response(output: &mut impl Write, value: &Value) -> std::io::Result<()> {
    serde_json::to_writer(&mut *output, value).map_err(std::io::Error::other)?;
    output.write_all(b"\n")?;
    output.flush()
}

/// The command carries the original parent's PID: checking only getppid during
/// startup would adopt PID 1 if the parent died before this worker initialized.
fn bind_parent_lifetime(expected_parent: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let expected = libc::pid_t::try_from(expected_parent).map_err(std::io::Error::other)?;
        if expected <= 0 {
            return Err(std::io::Error::other("Invalid worker parent"));
        }
        #[cfg(target_os = "linux")]
        {
            // Covers busy synchronous JS without polling the VM or stdin.
            if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Close the set-PDEATHSIG race with a parent that has already died.
            if unsafe { libc::getppid() } != expected {
                return Err(std::io::Error::other("Worker parent exited"));
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            if unsafe { libc::getppid() } != expected {
                return Err(std::io::Error::other("Worker parent exited"));
            }
            std::thread::Builder::new()
                .name("enricher-parent".into())
                .spawn(move || loop {
                    if unsafe { libc::getppid() } != expected {
                        // No Rust/C stdio flush: the JS thread can hold stdout's lock.
                        unsafe { libc::_exit(1) };
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                })?;
        }
    }
    #[cfg(not(unix))]
    let _ = expected_parent; // Existing Windows CandidateChild Job owns lifetime.
    Ok(())
}
/// Internal command only: no config, discovery, logging setup or Agent access.
pub fn run_span_enricher_worker(path: &Path, expected_parent: u32) -> i32 {
    if bind_parent_lifetime(expected_parent).is_err() {
        return 1;
    }
    let mut output = std::io::stdout().lock();
    let mut engine = match Engine::load(path) {
        Ok(engine) => engine,
        Err(_) => {
            let _ = write_response(&mut output, &json!({"ok":false}));
            return 1;
        }
    };
    if write_response(&mut output, &json!({"ok":true})).is_err() {
        return 1;
    }
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else {
            return 1;
        };
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => match engine.enrich(&request) {
                Ok(patch) => json!({"ok":true,"patch":patch}),
                Err(_) => json!({"ok":false}),
            },
            Err(_) => json!({"ok":false}),
        };
        if write_response(&mut output, &response).is_err() {
            return 1;
        }
    }
    0
}
