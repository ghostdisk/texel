#include "migan.h"
#include <visp/vision.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <memory>
#include <stdexcept>

struct TexelMigan {
    visp::backend_device device;
    visp::migan_model model;
};

extern "C" TexelMigan* texel_migan_load(const char* path, bool cpu, char* error, size_t error_size) {
    try {
        auto result = std::make_unique<TexelMigan>();
        result->device = cpu ? visp::backend_init(visp::backend_type::cpu) : visp::backend_init();
        result->model = visp::migan_load_model(path, result->device);
        return result.release();
    } catch (const std::exception& exception) {
        std::snprintf(error, error_size, "%s", exception.what());
        return nullptr;
    }
}

extern "C" void texel_migan_destroy(TexelMigan* model) { delete model; }

extern "C" bool texel_migan_remove(
    TexelMigan* model, int width, int height, const uint8_t* input, const uint8_t* mask,
    uint8_t* output, char* error, size_t error_size) {
    try {
        // Edge padding retains the crop's aspect ratio at the model's square resolution.
        const int side = std::max(width, height);
        auto square = visp::image_alloc({side, side}, visp::image_format::rgb_u8);
        for (int y = 0; y < side; ++y) for (int x = 0; x < side; ++x) {
            const size_t source = (static_cast<size_t>(std::min(y, height - 1)) * width + std::min(x, width - 1)) * 3;
            std::memcpy(square.data.get() + (static_cast<size_t>(y) * side + x) * 3, input + source, 3);
        }
        const int resolution = model->model.params.resolution;
        auto image = visp::image_scale(square, {resolution, resolution});
        auto support = visp::image_alloc({resolution, resolution}, visp::image_format::alpha_u8);
        visp::image_clear(support);
        // Max coverage preserves narrow selections when reducing a large crop.
        for (int y = 0; y < resolution; ++y) for (int x = 0; x < resolution; ++x) {
            const int left = x * side / resolution, top = y * side / resolution;
            const int right = std::min(side, ((x + 1) * side + resolution - 1) / resolution);
            const int bottom = std::min(side, ((y + 1) * side + resolution - 1) / resolution);
            bool selected = false;
            for (int sy = top; sy < bottom && !selected; ++sy) for (int sx = left; sx < right; ++sx) {
                const size_t source = static_cast<size_t>(std::min(sy, height - 1)) * width + std::min(sx, width - 1);
                if (mask[source]) { selected = true; break; }
            }
            support.data[static_cast<size_t>(y) * resolution + x] = selected ? 255 : 0;
        }
        auto filled = visp::migan_compute(model->model, image, support);
        // The editor applies the original soft selection exactly once. Remove the
        // library's binary alpha before resizing to avoid dark selection fringes.
        for (int i = 0; i < resolution * resolution; ++i) filled.data[i * 4 + 3] = 255;
        auto restored = visp::image_scale(filled, {side, side});
        for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
            std::memcpy(output + (static_cast<size_t>(y) * width + x) * 3,
                restored.data.get() + (static_cast<size_t>(y) * side + x) * 4, 3);
        }
        return true;
    } catch (const std::exception& exception) {
        std::snprintf(error, error_size, "%s", exception.what());
        return false;
    }
}
