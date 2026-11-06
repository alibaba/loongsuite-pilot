//! Original PII workload/iteration/p95 contracts. Only this executable owns
//! the allocator; CPU is actual process user+kernel time, not elapsed wall time.
use loongsuite_pilot::mask::{
    load_enabled_rules, load_mask_plan, mask_string, MaskConfig, PlanOrRules, StringMaskOptions,
};
use serde_json::{json, Value};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Instant;
static LIVE: AtomicI64 = AtomicI64::new(0);
struct MeasuredAllocator;
// SAFETY: System keeps all pointer/layout ownership. Atomic accounting does not
// allocate or change allocation results; null realloc leaves the old block live.
unsafe impl GlobalAlloc for MeasuredAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            LIVE.fetch_add(layout.size() as i64, Ordering::Relaxed);
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            LIVE.fetch_add(layout.size() as i64, Ordering::Relaxed);
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as i64, Ordering::Relaxed);
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let result = unsafe { System.realloc(pointer, layout, new_size) };
        if !result.is_null() {
            LIVE.fetch_add(new_size as i64 - layout.size() as i64, Ordering::Relaxed);
        }
        result
    }
}
#[global_allocator]
static ALLOCATOR: MeasuredAllocator = MeasuredAllocator;
#[cfg(unix)]
fn cpu_ms() -> f64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage initializes the provided rusage on success.
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
        0
    );
    let usage = unsafe { usage.assume_init() };
    (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) as f64 * 1000.0
        + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) as f64 / 1000.0
}
#[cfg(windows)]
fn cpu_ms() -> f64 {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let mut created = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    // SAFETY: the current-process pseudo handle remains valid; each pointer is
    // a distinct writable FILETIME and no ownership of that handle is taken.
    assert_ne!(
        unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        },
        0
    );
    let ticks =
        |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    (ticks(kernel) + ticks(user)) as f64 / 10000.0
}
fn benchmark(name: &str, input: &str, iterations: usize, plan: PlanOrRules<'_>) -> Value {
    let options = StringMaskOptions::default();
    for _ in 0..5 {
        drop(std::hint::black_box(mask_string(input, plan, &options)));
    }
    let mut timings = Vec::with_capacity(iterations);
    let heap_before = LIVE.load(Ordering::Relaxed);
    let cpu_before = cpu_ms();
    for _ in 0..iterations {
        let start = Instant::now();
        drop(std::hint::black_box(mask_string(input, plan, &options)));
        timings.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let cpu = cpu_ms() - cpu_before;
    let heap = LIVE.load(Ordering::Relaxed) - heap_before;
    let total: f64 = timings.iter().sum();
    timings.sort_by(f64::total_cmp);
    let p95 = timings[(iterations * 95).div_ceil(100) - 1];
    json!({"name":name,"bytes":input.len(),"iterations":iterations,"averageMs":total/iterations as f64,
        "p95Ms":p95,"throughputMiBPerSecond":(input.len()*iterations) as f64/(1024.0*1024.0)/(total/1000.0),
        "cpuMsPerIteration":cpu/iterations as f64,"heapDeltaBytes":heap})
}
#[test]
fn history_l65_original_twelve_masking_workloads_keep_all_iterations_p95_and_exact_content_assertions(
) {
    let config: MaskConfig =
        serde_json::from_value(json!({"mode":"all","types":[],"replacementMode":"placeholder"}))
            .unwrap();
    let rules = load_enabled_rules(&config);
    let all = load_mask_plan(&config);
    let preview = load_mask_plan(
        &serde_json::from_value(json!({"mode":"all","types":[],"replacementMode":"preview"}))
            .unwrap(),
    );
    let phone = load_mask_plan(
        &serde_json::from_value(
            json!({"mode":"custom","types":["phone"],"replacementMode":"placeholder"}),
        )
        .unwrap(),
    );
    let plain = "ordinary collector output without sensitive values\n".repeat(1500);
    let numeric = "event=12345 duration_ms=678 token_count=901 model_version=v5\n".repeat(1200);
    let fragmented = (vec!["1"; 64].join(" ") + "|").repeat(512);
    let mixed = [
        &plain[..plain.len() / 2],
        "id=11010519491231002X",
        "phone=13800138000",
        "email=user@example.com",
        "ip=192.168.1.10",
        "card=4111111111111111",
        &plain[plain.len() / 2..],
    ]
    .join("\n");
    let dense =
        vec!["11010519491231002X 13800138000 user@example.com 192.168.1.10 4111111111111111"; 250]
            .join("\n");
    let secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/+_==";
    let unanchored = vec![secret; 1000].join(" ");
    let anchored = vec![format!("AKIA1234567890ABCDEF:{secret}"); 300].join("\n");
    let results = [
        benchmark(
            "legacy-rules:plain",
            &plain,
            100,
            PlanOrRules::Rules(&rules),
        ),
        benchmark("all-rules:plain", &plain, 100, PlanOrRules::Plan(&all)),
        benchmark(
            "all-rules:numeric-noise",
            &numeric,
            100,
            PlanOrRules::Plan(&all),
        ),
        benchmark(
            "all-rules:fragmented-numeric",
            &fragmented,
            20,
            PlanOrRules::Plan(&all),
        ),
        benchmark("phone-only:mixed", &mixed, 100, PlanOrRules::Plan(&phone)),
        benchmark("all-rules:mixed", &mixed, 100, PlanOrRules::Plan(&all)),
        benchmark(
            "all-rules:dense-matches",
            &dense,
            20,
            PlanOrRules::Plan(&all),
        ),
        benchmark(
            "all-preview:plain",
            &plain,
            100,
            PlanOrRules::Plan(&preview),
        ),
        benchmark(
            "all-preview:mixed",
            &mixed,
            100,
            PlanOrRules::Plan(&preview),
        ),
        benchmark(
            "all-preview:dense-matches",
            &dense,
            20,
            PlanOrRules::Plan(&preview),
        ),
        benchmark(
            "all-rules:unanchored-secret-like",
            &unanchored,
            100,
            PlanOrRules::Plan(&all),
        ),
        benchmark(
            "all-rules:anchored-access-key-secrets",
            &anchored,
            50,
            PlanOrRules::Plan(&all),
        ),
    ];
    println!(
        "[pii-mask-perf] {}",
        serde_json::to_string(&results).unwrap()
    );
    for (index, result) in results.iter().enumerate().skip(1) {
        let budget = if matches!(index, 6 | 9) { 100.0 } else { 50.0 };
        assert!(
            result["p95Ms"].as_f64().unwrap() < budget,
            "{} p95 exceeded original {budget}ms: {}",
            result["name"],
            result["p95Ms"]
        );
    }
    let options = StringMaskOptions::default();
    let mask =
        |text: &str, plan: &_| mask_string(text, PlanOrRules::Plan(plan), &options).into_owned();
    let masked = mask(&mixed, &all);
    for original in [
        "11010519491231002X",
        "13800138000",
        "user@example.com",
        "192.168.1.10",
        "4111111111111111",
    ] {
        assert!(!masked.contains(original));
    }
    let masked_dense = mask(&dense, &all);
    for token in [
        "[IDCARD_MASKED]",
        "[PHONE_MASKED]",
        "[EMAIL_MASKED]",
        "[IP_ADDRESS_MASKED]",
        "[CREDIT_CARD_MASKED]",
    ] {
        assert_eq!(masked_dense.matches(token).count(), 250, "{token}");
    }
    let mixed_preview = mask(&mixed, &preview);
    assert!(mixed_preview.contains("[PHONE_MASKED]{138****8000}"));
    assert!(mixed_preview.contains("[IP_ADDRESS_MASKED]{192.*.*.10}"));
    assert_eq!(mask(&unanchored, &all), unanchored);
    let masked_anchored = mask(&anchored, &all);
    assert_eq!(
        masked_anchored.matches("[ACCESSKEY_SECRET_MASKED]").count(),
        300
    );
    assert!(!masked_anchored.contains(secret));
}
