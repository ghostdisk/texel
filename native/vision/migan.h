#pragma once
#include <cstddef>
#include <cstdint>

#if defined(_WIN32)
#if defined(VISP_API_EXPORT)
#define TEXEL_VISION_API __declspec(dllexport)
#else
#define TEXEL_VISION_API __declspec(dllimport)
#endif
#else
#define TEXEL_VISION_API __attribute__((visibility("default")))
#endif

struct TexelMigan;

extern "C" {
TEXEL_VISION_API TexelMigan* texel_migan_load(const char* path, bool cpu, char* error, size_t error_size);
TEXEL_VISION_API void texel_migan_destroy(TexelMigan* model);
// Packed RGB8 input, binary mask (255 = remove), and caller-owned RGB8 output.
TEXEL_VISION_API bool texel_migan_remove(
    TexelMigan* model, int width, int height, const uint8_t* input, const uint8_t* mask,
    uint8_t* output, char* error, size_t error_size);
}
