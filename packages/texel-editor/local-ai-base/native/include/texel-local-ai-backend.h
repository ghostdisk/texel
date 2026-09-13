#pragma once

#include <cstddef>
#include <cstdint>

#if defined(_WIN32)
#define TEXEL_LOCAL_AI_EXPORT __declspec(dllexport)
#define TEXEL_LOCAL_AI_CALL __cdecl
#else
#define TEXEL_LOCAL_AI_EXPORT __attribute__((visibility("default")))
#define TEXEL_LOCAL_AI_CALL
#endif

constexpr uint32_t TEXEL_LOCAL_AI_ABI_VERSION = 1;

struct TexelLocalAiHost {
    uint32_t abi_version;
    void* user;
    void (TEXEL_LOCAL_AI_CALL *send_text)(void* user, uint64_t session, const char* data, size_t size);
    void (TEXEL_LOCAL_AI_CALL *send_binary)(void* user, uint64_t session, const uint8_t* data, size_t size);
    void (TEXEL_LOCAL_AI_CALL *close)(void* user, uint64_t session, uint16_t code, const char* reason);
    void (TEXEL_LOCAL_AI_CALL *log)(void* user, const char* data, size_t size);
};

struct TexelLocalAiConfig {
    uint32_t abi_version;
    const char* model_root;
    const char* model_config;
};

struct TexelLocalAiBackend {
    uint32_t abi_version;
    void* (TEXEL_LOCAL_AI_CALL *create)(
        const TexelLocalAiHost* host,
        const TexelLocalAiConfig* config,
        char* error,
        size_t error_size);
    void (TEXEL_LOCAL_AI_CALL *destroy)(void* backend);
    void (TEXEL_LOCAL_AI_CALL *connect)(void* backend, uint64_t session);
    void (TEXEL_LOCAL_AI_CALL *disconnect)(void* backend, uint64_t session);
    void (TEXEL_LOCAL_AI_CALL *message)(
        void* backend,
        uint64_t session,
        const uint8_t* data,
        size_t size,
        bool binary);
};

using TexelLocalAiBackendEntry = const TexelLocalAiBackend* (TEXEL_LOCAL_AI_CALL*)();

extern "C" TEXEL_LOCAL_AI_EXPORT const TexelLocalAiBackend* TEXEL_LOCAL_AI_CALL texel_local_ai_backend();
