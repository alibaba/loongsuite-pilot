/* Native host without a Rust runtime. Test that SDK shutdown returns sockets to the host. */
#include "../include/pilot_sdk.h"
#include <dirent.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#define REQUIRE(expr) do { if (!(expr)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #expr); exit(1); } } while (0)

typedef struct Host {
    const PilotApiV2 *api;
    const char *options;
    const char *policy;
    bool started;
    bool stopped;
} Host;

static PilotJsonView view(const char *text) {
    return (PilotJsonView){(const uint8_t *)text, strlen(text)};
}

static void pause_host(void) {
    struct timespec interval = {0, 10000000};
    nanosleep(&interval, NULL);
}

static unsigned socket_count(void) {
    DIR *fds = opendir("/dev/fd");
    REQUIRE(fds != NULL);
    struct dirent *entry;
    unsigned count = 0;
    while ((entry = readdir(fds)) != NULL) {
        char *end;
        long fd = strtol(entry->d_name, &end, 10);
        struct stat info;
        if (end != entry->d_name && !*end && fstat((int)fd, &info) == 0 && S_ISSOCK(info.st_mode)) {
            ++count;
        }
    }
    closedir(fds);
    return count;
}

static int32_t accept_batch(void *ctx, const PilotJsonView *events, size_t count) {
    (void)ctx; (void)events; (void)count;
    return PILOT_EMIT_ACK;
}

static void started(void *ctx, PilotHandle *handle, int32_t result, PilotJsonView report) {
    (void)handle; (void)report;
    REQUIRE(result == PILOT_OK);
    ((Host *)ctx)->started = true;
}

static void stopped(void *ctx, PilotHandle *handle, int32_t result, PilotJsonView report) {
    (void)handle; (void)report;
    REQUIRE(result == PILOT_OK);
    ((Host *)ctx)->stopped = true;
}

static void *run_sdk(void *ctx) {
    Host *host = ctx;
    const PilotApiV2 *api = host->api;
    PilotHandle *handle = NULL;
    REQUIRE(api->start(view(host->options), view(host->policy), accept_batch, accept_batch,
                       NULL, started, stopped, host, &handle) == PILOT_OK);
    for (unsigned i = 0; i < 1500 && !host->started; ++i) {
        REQUIRE(api->dispatch(handle, 0) == PILOT_OK);
        pause_host();
    }
    REQUIRE(host->started);
    printf("running_sockets=%u\n", socket_count());
    REQUIRE(api->stop(handle, 0) == PILOT_OK);
    for (unsigned i = 0; i < 1500 && !host->stopped; ++i) {
        REQUIRE(api->dispatch(handle, 0) == PILOT_OK);
        pause_host();
    }
    REQUIRE(host->stopped);
    int32_t status = PILOT_BUSY;
    for (unsigned i = 0; i < 1500 && status == PILOT_BUSY; ++i) {
        status = api->destroy(handle);
        if (status == PILOT_BUSY) pause_host();
    }
    REQUIRE(status == PILOT_OK);
    return NULL;
}

static unsigned image_count(const char *path) {
    unsigned count = 0;
    for (uint32_t i = 0; i < _dyld_image_count(); ++i) {
        const char *name = _dyld_get_image_name(i);
        if (!name) continue;
        char *resolved = realpath(name, NULL);
        if (resolved && strcmp(path, resolved) == 0) ++count;
        free(resolved);
    }
    return count;
}

int main(int argc, char **argv) {
    REQUIRE(argc >= 3);
    const char *options = strcmp(argv[1], "--load-only") ? argv[1] : NULL;
    REQUIRE(!options || argc >= 4);
    unsigned baseline = socket_count();
    bool retained_socket = false;
    printf("baseline_sockets=%u\n", baseline);
    int first_library = options ? 3 : 2;
    for (int i = first_library; i < argc; ++i) {
        char *library_path = realpath(argv[i], NULL);
        REQUIRE(library_path != NULL);
        void *library = dlopen(library_path, RTLD_NOW | RTLD_LOCAL);
        if (!library) fprintf(stderr, "%s\n", dlerror());
        REQUIRE(library && image_count(library_path) == 1);
        if (options) {
            const PilotApiV2 *(*get_api)(void) = (const PilotApiV2 *(*)(void))dlsym(library, "aah_collector_get_api_v2");
            REQUIRE(get_api != NULL);
            Host host = {.api = get_api(), .options = options, .policy = argv[2]};
            REQUIRE(host.api && host.api->abi_version == PILOT_ABI_VERSION &&
                    host.api->struct_size >= sizeof(PilotApiV2));
            pthread_t control;
            REQUIRE(pthread_create(&control, NULL, run_sdk, &host) == 0);
            REQUIRE(pthread_join(control, NULL) == 0);
        }
        int result = dlclose(library);
        unsigned sockets = socket_count();
        unsigned images = image_count(library_path);
        printf("round=%d dlclose=%d images_for_path=%u sockets_after=%u\n", i - first_library + 1, result, images, sockets);
        REQUIRE(result == 0 && images <= 1);
        retained_socket |= sockets != baseline;
        free(library_path);
    }
    return retained_socket ? 1 : 0;
}
