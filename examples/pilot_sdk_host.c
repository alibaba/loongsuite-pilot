#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
/* Minimal C host. Link the SDK shared library, pass init.json and policy.json.
 * This example pumps lifecycle callbacks; it does not start Pilot services. */
#include "../include/pilot_sdk.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
static void pause_host(void) { Sleep(10); }
#else
#include <time.h>
static void pause_host(void) { struct timespec wait = {0, 10000000}; nanosleep(&wait, NULL); }
#endif
typedef struct Host { int started, stopped, result; } Host;
static int32_t accept_batch(void *ctx, const PilotJsonView *events, size_t count) {
    size_t i; (void)ctx;
    for (i=0; i<count; ++i) if (!events[i].data || !events[i].len) return PILOT_EMIT_RETRY;
    /* A real host copies/checks its whole batch before returning ACK. */
    return PILOT_EMIT_ACK;
}
static int32_t decide(void *ctx, PilotJsonView request, uint32_t remaining,
    uint8_t *reply, size_t capacity, size_t *length) {
    const char result[] = "{\"action\":\"allow\"}";
    (void)ctx; (void)request;
    if (!remaining || capacity < sizeof(result)-1) return PILOT_FAILURE;
    memcpy(reply, result, sizeof(result)-1); *length=sizeof(result)-1; return PILOT_OK;
}
static void started(void *ctx, PilotHandle *handle, int32_t result, PilotJsonView report) {
    Host *host=(Host *)ctx; (void)handle; (void)report; host->started=1; host->result=result;
}
static void stopped(void *ctx, PilotHandle *handle, int32_t result, PilotJsonView report) {
    Host *host=(Host *)ctx; (void)handle; (void)result; (void)report; host->stopped=1;
}
static char *read_json(const char *path, size_t *length) {
    FILE *file; char *bytes; long size;
#ifdef _WIN32
    if (fopen_s(&file,path,"rb")) return NULL;
#else
    file=fopen(path,"rb");
#endif
    if (!file) return NULL;
    if (fseek(file,0,SEEK_END) || (size=ftell(file))<=0 || size>8*1024*1024 || fseek(file,0,SEEK_SET)) { fclose(file); return NULL; }
    bytes=(char *)malloc((size_t)size);
    if (!bytes || fread(bytes,1,(size_t)size,file)!=(size_t)size) { free(bytes); fclose(file); return NULL; }
    fclose(file); *length=(size_t)size; return bytes;
}
int main(int argc, char **argv) {
    const PilotApiV2 *api=aah_collector_get_api_v2(); Host host={0,0,0};
    PilotHandle *handle=NULL; char *init,*policy,*report=NULL; size_t init_len=0,policy_len=0,report_len=0; int code;
    if (argc!=3 || !api || api->abi_version!=PILOT_ABI_VERSION || api->struct_size<sizeof(*api)) return 2;
    init=read_json(argv[1],&init_len); policy=read_json(argv[2],&policy_len);
    if (!init || !policy) { free(init); free(policy); return 2; }
    code=api->start((PilotJsonView){(const uint8_t *)init,init_len},(PilotJsonView){(const uint8_t *)policy,policy_len},accept_batch,accept_batch,decide,started,stopped,&host,&handle);
    free(init); free(policy);
    if (code!=PILOT_OK) return 3;
    while (!host.started) { api->dispatch(handle,0); pause_host(); }
    if (api->snapshot(handle,&report,&report_len)==PILOT_OK) {
        fwrite(report,1,report_len,stdout); fputc('\n',stdout); api->string_free(report);
    }
    if (api->stop(handle,1000)!=PILOT_OK) return 4;
    while (!host.stopped) { api->dispatch(handle,0); pause_host(); }
    while ((code=api->destroy(handle))==PILOT_BUSY) pause_host();
    return code==PILOT_OK && host.result==PILOT_OK ? 0 : 5;
}
