#pragma once

#include <cstdint>

const unsigned char* texel_shader_data(const char* name, uint64_t expected_size);
const char* texel_shader_archive_error();
