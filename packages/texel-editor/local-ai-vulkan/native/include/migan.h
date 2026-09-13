#pragma once
#include <cstddef>
#include <cstdint>

struct TexelMigan;

extern "C" {
TexelMigan* texel_migan_load(const char* path, bool cpu, char* error, size_t error_size);
void texel_migan_destroy(TexelMigan* model);
// Packed RGB8 input, binary mask (255 = remove), and caller-owned RGB8 output.
bool texel_migan_remove(
    TexelMigan* model, int width, int height, const uint8_t* input, const uint8_t* mask,
    uint8_t* output, char* error, size_t error_size);
}
