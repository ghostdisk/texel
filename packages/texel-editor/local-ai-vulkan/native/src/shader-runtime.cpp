#include "texel-shader-runtime.h"

#include <windows.h>

#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

extern "C" int mz_uncompress(unsigned char* destination, unsigned long* destination_size,
                              const unsigned char* source, unsigned long source_size);
constexpr int MZ_OK = 0;

namespace {
struct ShaderSpan {
    size_t offset;
    uint32_t size;
};

std::vector<unsigned char> storage;
std::unordered_map<std::string, ShaderSpan> shaders;
std::string load_error;
bool loaded = false;

uint16_t read_u16(const unsigned char*& cursor, const unsigned char* end) {
    if (end - cursor < 2) throw std::runtime_error("truncated shader archive");
    uint16_t value;
    std::memcpy(&value, cursor, sizeof(value));
    cursor += sizeof(value);
    return value;
}

uint32_t read_u32(const unsigned char*& cursor, const unsigned char* end) {
    if (end - cursor < 4) throw std::runtime_error("truncated shader archive");
    uint32_t value;
    std::memcpy(&value, cursor, sizeof(value));
    cursor += sizeof(value);
    return value;
}

std::wstring archive_path() {
    HMODULE module = nullptr;
    const auto address = reinterpret_cast<LPCWSTR>(&texel_shader_data);
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            address, &module)) {
        throw std::runtime_error("cannot locate the Vulkan backend module");
    }
    std::wstring path(32768, L'\0');
    const DWORD size = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
    if (!size || size == path.size()) throw std::runtime_error("cannot resolve the Vulkan backend path");
    path.resize(size);
    const size_t separator = path.find_last_of(L"\\/");
    path.resize(separator == std::wstring::npos ? 0 : separator + 1);
    return path + L"texel-local-ai-vulkan.shaders";
}

void load_archive() {
    if (loaded) return;
    loaded = true;
    try {
        std::ifstream stream(archive_path(), std::ios::binary | std::ios::ate);
        if (!stream) throw std::runtime_error("texel-local-ai-vulkan.shaders is missing");
        const auto file_size = stream.tellg();
        if (file_size < 16) throw std::runtime_error("shader archive header is truncated");
        std::vector<unsigned char> file(static_cast<size_t>(file_size));
        stream.seekg(0);
        stream.read(reinterpret_cast<char*>(file.data()), file_size);
        if (!stream || std::memcmp(file.data(), "TXSHDR01", 8) != 0) {
            throw std::runtime_error("shader archive has an invalid header");
        }
        const unsigned char* header = file.data() + 8;
        const unsigned char* file_end = file.data() + file.size();
        const uint32_t raw_size = read_u32(header, file_end);
        const uint32_t compressed_size = read_u32(header, file_end);
        if (compressed_size != file.size() - 16) throw std::runtime_error("shader archive size does not match its header");
        storage.resize(raw_size);
        unsigned long output_size = raw_size;
        const int result = mz_uncompress(storage.data(), &output_size, file.data() + 16, compressed_size);
        if (result != MZ_OK || output_size != raw_size) throw std::runtime_error("shader archive could not be decompressed");

        const unsigned char* cursor = storage.data();
        const unsigned char* end = storage.data() + storage.size();
        const uint32_t count = read_u32(cursor, end);
        for (uint32_t i = 0; i < count; ++i) {
            const uint16_t name_size = read_u16(cursor, end);
            const uint32_t data_size = read_u32(cursor, end);
            if (end - cursor < name_size + data_size) throw std::runtime_error("shader archive entry is truncated");
            std::string name(reinterpret_cast<const char*>(cursor), name_size);
            cursor += name_size;
            shaders.emplace(std::move(name), ShaderSpan{static_cast<size_t>(cursor - storage.data()), data_size});
            cursor += data_size;
        }
        if (cursor != end) throw std::runtime_error("shader archive has trailing data");
    } catch (const std::exception& error) {
        load_error = error.what();
    }
}
}

const unsigned char* texel_shader_data(const char* name, uint64_t expected_size) {
    load_archive();
    if (!load_error.empty()) return nullptr;
    const auto found = shaders.find(name);
    if (found == shaders.end()) {
        load_error = std::string("shader archive does not contain ") + name;
        return nullptr;
    }
    if (found->second.size != expected_size) {
        load_error = std::string("shader archive contains the wrong size for ") + name;
        return nullptr;
    }
    return storage.data() + found->second.offset;
}

const char* texel_shader_archive_error() {
    load_archive();
    return load_error.empty() ? nullptr : load_error.c_str();
}
