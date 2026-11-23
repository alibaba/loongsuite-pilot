#ifndef LOONGSUITE_PILOT_SDK_H
#define LOONGSUITE_PILOT_SDK_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define PILOT_ABI_VERSION 2u
#define PILOT_OK 0
#define PILOT_BAD_ARGUMENT 1
#define PILOT_BUSY 2
#define PILOT_FAILURE 3
#define PILOT_EMIT_ACK 0
#define PILOT_EMIT_RETRY 1
#define PILOT_CAP_ACTIVITY_V2 UINT64_C(1)
#define PILOT_CAP_HOOK_UDP UINT64_C(2)
#define PILOT_CAP_MONITORING UINT64_C(4)
#define PILOT_CAP_CODEX_HOOK_CONTROL UINT64_C(32)

typedef struct PilotHandle PilotHandle;
typedef struct PilotJsonView { const uint8_t *data; size_t len; } PilotJsonView;
typedef int32_t (*PilotOnBatch)(void *, const PilotJsonView *, size_t);
typedef void (*PilotOnLifecycle)(void *, PilotHandle *, int32_t, PilotJsonView);
typedef int32_t (*PilotOnHook)(void *, PilotJsonView, uint32_t, uint8_t *, size_t, size_t *);

/* All JSON is UTF-8 with a byte length; no input NUL terminator is required.
 * Inputs and callback views are borrowed only until that call returns.
 * The host retains callback code/context through successful destroy. Activity,
 * monitoring and hook callbacks use independent SDK threads and must be thread
 * safe. They must return: a blocked host callback keeps stop/destroy BUSY rather
 * than allowing an unsafe unload. No exception may cross this C boundary.
 * The cloud hook channel may invoke on_hook concurrently up to 32 times
 * per instance and queue another 32 requests. Honor its remaining-ms argument.
 *
 * start/stop return acceptance promptly. After each accepting call RETURNS,
 * the host control thread calls dispatch(handle, 0) until its lifecycle callback
 * arrives. This explicit handoff guarantees notification cannot precede the
 * accepting call's return. Lifecycle callbacks only copy/notify; destroy inside
 * a callback returns BUSY. Serialize control calls for each handle; snapshot is
 * safe from callbacks. No concurrent SDK calls may remain at unload.
 *
 * Activity ACK accepts the whole batch. RETRY/unknown codes retain original
 * bytes and event.id. The host owns any persistence/de-duplication after ACK.
 * Reports allocated by the SDK must be freed once, using string_free from the
 * SAME loaded SDK. NULL is accepted by string_free. Stop a failed start too.
 * After on_stop returns, retry destroy while BUSY. Unload only after OK.
 * Prefer a dedicated control thread and join it before closing the library.
 * On macOS dyld retains this library's image because it contains thread-local
 * storage. Successful dlclose releases the handle, not the image mapping.
 * Restart the host process to reclaim the image when changing SDK paths.
 */
typedef struct PilotApiV2 {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t capabilities;
    int32_t (*start)(PilotJsonView, PilotJsonView, PilotOnBatch, PilotOnBatch,
        PilotOnHook, PilotOnLifecycle, PilotOnLifecycle, void *, PilotHandle **);
    /* CAP_CODEX_HOOK_CONTROL: apply_policy also accepts a standalone
     * {"hook_management":{"agent":"codex","operation":"list"}} request.
     * Use "clear" after on_stop and before destroy to remove this instance's hooks. */
    int32_t (*apply_policy)(PilotHandle *, PilotJsonView, char **, size_t *);
    int32_t (*snapshot)(PilotHandle *, char **, size_t *);
    int32_t (*stop)(PilotHandle *, uint32_t);
    int32_t (*destroy)(PilotHandle *);
    void (*string_free)(char *);
    int32_t (*dispatch)(PilotHandle *, uint32_t reserved_zero);
    /* Historical complete Pilot startup slot, reserved to keep v2 layout.
     * The complete Pilot executable owns its command runtime. */
    int32_t (*host_main)(void);
    /* Reserved historical command slot. The full Pilot executable owns legacy Hooks. */
    int32_t (*host_hook)(PilotJsonView args, PilotJsonView input, char **report, size_t *len);
} PilotApiV2;

const PilotApiV2 *aah_collector_get_api_v2(void);
#ifdef __cplusplus
}
#endif
#endif
