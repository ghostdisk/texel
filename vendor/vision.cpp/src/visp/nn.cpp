#include "nn.h"
#include "util/string.h"

#include <cmath>
#include <cstdint>

namespace visp {

namespace {

struct deform_params {
    int stride;
    int pad;
};

float tensor_f32(const ggml_tensor* tensor, int64_t x, int64_t y, int64_t c, int64_t n) {
    auto* data = static_cast<const char*>(tensor->data);
    return *reinterpret_cast<const float*>(data + x * tensor->nb[0] + y * tensor->nb[1] + c * tensor->nb[2] + n * tensor->nb[3]);
}

float bilinear_f32(const ggml_tensor* tensor, float x, float y, int64_t c, int64_t n) {
    const int64_t x0 = static_cast<int64_t>(std::floor(x));
    const int64_t y0 = static_cast<int64_t>(std::floor(y));
    const int64_t x1 = x0 + 1;
    const int64_t y1 = y0 + 1;
    const float dx = x - static_cast<float>(x0);
    const float dy = y - static_cast<float>(y0);
    const auto sample = [tensor, c, n](int64_t sx, int64_t sy) {
        if (sx < 0 || sy < 0 || sx >= tensor->ne[0] || sy >= tensor->ne[1]) return 0.0f;
        return tensor_f32(tensor, sx, sy, c, n);
    };
    const float upper = sample(x0, y0) * (1.0f - dx) + sample(x1, y0) * dx;
    const float lower = sample(x0, y1) * (1.0f - dx) + sample(x1, y1) * dx;
    return upper * (1.0f - dy) + lower * dy;
}

void deform_conv_f32(ggml_tensor* dst, int ith, int nth, void* userdata) {
    const auto bits = reinterpret_cast<uintptr_t>(userdata);
    const deform_params params{static_cast<int>(bits & 0xffff), static_cast<int>((bits >> 16) & 0xffff)};
    const ggml_tensor* weight = dst->src[0];
    const ggml_tensor* input = dst->src[1];
    const ggml_tensor* offset = dst->src[2];
    const ggml_tensor* mask = dst->src[3];
    GGML_ASSERT(weight->type == GGML_TYPE_F32 && input->type == GGML_TYPE_F32);
    GGML_ASSERT(offset->type == GGML_TYPE_F32 && (!mask || mask->type == GGML_TYPE_F32));

    const int64_t width = dst->ne[0];
    const int64_t height = dst->ne[1];
    const int64_t channels_out = dst->ne[2];
    const int64_t batch = dst->ne[3];
    const int64_t kernel_width = weight->ne[0];
    const int64_t kernel_height = weight->ne[1];
    const int64_t channels_in = weight->ne[2];
    const int64_t total = width * height * channels_out * batch;

    for (int64_t index = ith; index < total; index += nth) {
        int64_t cursor = index;
        const int64_t x = cursor % width;
        cursor /= width;
        const int64_t y = cursor % height;
        cursor /= height;
        const int64_t channel_out = cursor % channels_out;
        const int64_t batch_index = cursor / channels_out;
        float sum = 0.0f;

        for (int64_t channel_in = 0; channel_in < channels_in; ++channel_in) {
            for (int64_t kernel_y = 0; kernel_y < kernel_height; ++kernel_y) {
                for (int64_t kernel_x = 0; kernel_x < kernel_width; ++kernel_x) {
                    const int64_t kernel_index = kernel_y * kernel_width + kernel_x;
                    const float offset_y = tensor_f32(offset, x, y, kernel_index * 2, batch_index);
                    const float offset_x = tensor_f32(offset, x, y, kernel_index * 2 + 1, batch_index);
                    const float source_x = static_cast<float>(x * params.stride + kernel_x - params.pad) + offset_x;
                    const float source_y = static_cast<float>(y * params.stride + kernel_y - params.pad) + offset_y;
                    const float modulation = mask ? tensor_f32(mask, x, y, kernel_index, batch_index) : 1.0f;
                    sum += bilinear_f32(input, source_x, source_y, channel_in, batch_index)
                        * tensor_f32(weight, kernel_x, kernel_y, channel_in, channel_out) * modulation;
                }
            }
        }

        auto* data = static_cast<char*>(dst->data);
        *reinterpret_cast<float*>(data + x * dst->nb[0] + y * dst->nb[1]
            + channel_out * dst->nb[2] + batch_index * dst->nb[3]) = sum;
    }
}

} // namespace

tensor linear(model_ref m, tensor x) {
    x = ggml_mul_mat(m, m.weights("weight"), x);
    if (tensor bias = m.find("bias")) {
        x = ggml_add_inplace(m, x, bias);
    }
    return x;
}

tensor layer_norm(model_ref m, tensor x, float eps) {
    x = ggml_norm(m, x, eps);
    x = ggml_mul_inplace(m, x, m.weights("weight"));
    x = ggml_add_inplace(m, x, m.weights("bias"));
    return named(m, x);
}

tensor permute_cwhn_to_whcn(model_ref m, tensor x) {
    return ggml_permute(m, x, 2, 0, 1, 3);
}

tensor permute_whcn_to_cwhn(model_ref m, tensor x) {
    return ggml_permute(m, x, 1, 2, 0, 3);
}

std::array<int64_t, 4> nelements_whcn(model_ref const& m, tensor t) {
    auto ne = nelements(t);
    return (m.flags & model_build_flag::cwhn) ? std::array{ne[1], ne[2], ne[0], ne[3]} : ne;
}

tensor cwhn_to_contiguous_2d(model_ref m, tensor x) {
    if (m.flags & model_build_flag::cwhn) {
        return x; // preferred 2D layout is CWHN too
    }
    return ggml_cont(m, permute_cwhn_to_whcn(m, x));
}

tensor whcn_to_contiguous_2d(model_ref m, tensor x) {
    if (m.flags & model_build_flag::cwhn) {
        return ggml_cont(m, permute_whcn_to_cwhn(m, x));
    }
    return x;
}

tensor contiguous_2d_to_cwhn(model_ref m, tensor x) {
    if (m.flags & model_build_flag::cwhn) {
        return x; // x is already CWHN
    }
    return ggml_cont(m, permute_whcn_to_cwhn(m, x));
}

tensor contiguous_2d_to_whcn(model_ref m, tensor x) {
    if (m.flags & model_build_flag::cwhn) {
        return ggml_cont(m, permute_cwhn_to_whcn(m, x));
    }
    return x;
}

tensor add_bias_2d(model_ref m, tensor x) {
    if (tensor bias = m.find("bias")) {
        if (!(m.flags & model_build_flag::cwhn)) {
            bias = ggml_reshape_4d(m, bias, 1, 1, bias->ne[0], 1);
        }
        x = ggml_add_inplace(m, x, bias);
    }
    return x;
}

tensor conv_2d(model_ref m, tensor x, int stride, int pad) {
    tensor weight = m.weights("weight");

    if (m.flags & model_build_flag::cwhn) {
        if (weight->ne[1] == 1 && weight->ne[2] == 1 && stride == 1) {
            auto [c, w, h, b] = nelements(x);
            weight = ggml_reshape_2d(m, weight, weight->ne[0], weight->ne[3]);
            x = ggml_reshape_2d(m, x, x->ne[0], w * h * b);
            x = ggml_mul_mat(m, weight, x);
            x = ggml_reshape_4d(m, x, weight->ne[1], w, h, b);

        } else if (m.flags & model_build_flag::conv_2d_direct_cwhn) {
            weight = permute_cwhn_to_whcn(m, weight);
            x = permute_cwhn_to_whcn(m, x);
            x = ggml_conv_2d_direct(m, weight, x, stride, stride, pad, pad, 1, 1);
            x = permute_whcn_to_cwhn(m, x);

        } else {
            weight = ggml_cont(m, permute_cwhn_to_whcn(m, weight));
            x = ggml_cont(m, permute_cwhn_to_whcn(m, x));
            x = ggml_conv_2d(m, weight, x, stride, stride, pad, pad, 1, 1);
            x = ggml_cont(m, permute_whcn_to_cwhn(m, x));
        }
    } else { // WHCN layout
        x = ggml_conv_2d_direct(m, weight, x, stride, stride, pad, pad, 1, 1);
    }
    x = add_bias_2d(m, x);
    return x;
}

tensor conv_2d_depthwise(model_ref m, tensor x, int stride, int pad) {
    tensor weight = m.weights("weight");

    if (m.flags & model_build_flag::cwhn) {
        weight = ggml_permute(m, weight, 3, 2, 0, 1);
        x = permute_cwhn_to_whcn(m, x);
        x = ggml_conv_2d_dw_direct(m, weight, x, stride, stride, pad, pad, 1, 1);
        x = permute_whcn_to_cwhn(m, x);
    } else {
        x = ggml_conv_2d_dw_direct(m, weight, x, stride, stride, pad, pad, 1, 1);
    }
    x = add_bias_2d(m, x);
    return x;
}

tensor conv_transpose_2d(model_ref m, tensor x, int stride) {
    tensor weight = m.weights("weight");
    if (m.flags & model_build_flag::f16_conv_transpose) {
        // TODO: ggml_conv_transpose_2d_p0 expects fp16 weights (cpu backend)
        weight = ggml_cast(m, weight, GGML_TYPE_F16);
    }
    if (m.flags & model_build_flag::cwhn) {
        x = ggml_cont(m, permute_cwhn_to_whcn(m, x));
    }
    x = ggml_conv_transpose_2d_p0(m, weight, x, stride);

    if (m.flags & model_build_flag::cwhn) {
        x = ggml_cont(m, permute_whcn_to_cwhn(m, x));
    }
    x = add_bias_2d(m, x);
    return x;
}

tensor conv_2d_deform(
    model_ref m, tensor x, tensor weight, tensor offset, tensor mask, int stride, int pad) {

    if (m.flags & model_build_flag::cwhn) {
        x = permute_cwhn_to_whcn(m, x);
        weight = permute_cwhn_to_whcn(m, weight);
        offset = permute_cwhn_to_whcn(m, offset);
        if (mask) {
            mask = permute_cwhn_to_whcn(m, mask);
        }
    }
    const int64_t width = (x->ne[0] + 2 * pad - weight->ne[0]) / stride + 1;
    const int64_t height = (x->ne[1] + 2 * pad - weight->ne[1]) / stride + 1;
    ggml_tensor* args[] = {weight, x, offset, mask};
    const int argument_count = mask ? 4 : 3;
    const uintptr_t params = static_cast<uintptr_t>(stride & 0xffff) | (static_cast<uintptr_t>(pad & 0xffff) << 16);
    x = ggml_custom_4d(m, GGML_TYPE_F32, width, height, weight->ne[3], x->ne[3], args,
        argument_count, deform_conv_f32, GGML_N_TASKS_MAX, reinterpret_cast<void*>(params));

    if (m.flags & model_build_flag::cwhn) {
        x = permute_whcn_to_cwhn(m, x);
    }
    return x;
}

tensor batch_norm_2d(model_ref m, tensor x) {
    // Batch norm is expected to be have been fused into mul+add. See convert.py
    ASSERT(m.find("running_mean") == nullptr, "Batch norm was not fused");
    ASSERT(m.find("running_var") == nullptr, "Batch norm was not fused");

    tensor weight = m.weights("weight");
    tensor bias = m.weights("bias");
    if (!(m.flags & model_build_flag::cwhn)) { // WHCN layout
        weight = ggml_reshape_4d(m, weight, 1, 1, weight->ne[0], 1);
        bias = ggml_reshape_4d(m, bias, 1, 1, bias->ne[0], 1);
    }
    x = ggml_mul_inplace(m, x, weight);
    x = ggml_add_inplace(m, x, bias);
    return named(m, x);
}

tensor patch_embed(model_ref m, tensor x, int patch_size) {
    ASSERT(x->ne[1] % patch_size == 0 && x->ne[2] % patch_size == 0);
    char const* proj = m.find("proj.weight") ? "proj" : "projection";

    m.flags |= model_build_flag::cwhn;
    x = conv_2d(m[proj], x, patch_size);

    if (m.find("norm.weight")) {
        auto [c, w, h, b] = nelements(x);
        x = ggml_reshape_3d(m, x, c, w * h, b);
        x = layer_norm(m["norm"], x);
        x = ggml_reshape_4d(m, x, c, w, h, b);
    }
    return named(m, x);
}

attention_qkv split_qkv(model_ref m, tensor x, int n_heads, int split_dim) {
    auto [c, n, b, _] = nelements(x);

    tensor qkv = linear(m, x);
    switch (split_dim) {
        case 1:
            qkv = ggml_reshape_4d(m, qkv, c / n_heads, 3, n_heads * n, b);
            qkv = ggml_cont(m, ggml_permute(m, qkv, 0, 3, 1, 2));
            break;
        case 2:
            qkv = ggml_reshape_4d(m, qkv, c / n_heads, n_heads, 3, n * b);
            qkv = ggml_cont(m, ggml_permute(m, qkv, 0, 1, 3, 2));
            break;
        default: ASSERT(false, "Unsupported split_dim");
    }

    auto split = [&](tensor t, size_t index) mutable {
        t = slice(m, t, {}, {}, {}, index);
        t = ggml_reshape_4d(m, t, c / n_heads, n_heads, n, b);
        return t;
    };

    tensor q = split(qkv, 0);
    tensor k = split(qkv, 1);
    tensor v = split(qkv, 2);
    return {q, k, v};
}

tensor attention(
    model_ref m, tensor q, tensor k, tensor v, tensor mask, float scale, model_ref m_out) {

    q = ggml_permute(m, q, 0, 2, 1, 3);
    k = ggml_permute(m, k, 0, 2, 1, 3);

    tensor x = nullptr;
    if (m.flags & model_build_flag::flash_attention) {
        v = ggml_permute(m, v, 0, 2, 1, 3);

        k = ggml_cast(m, k, GGML_TYPE_F16);
        v = ggml_cast(m, v, GGML_TYPE_F16);
        if (mask && mask->type != GGML_TYPE_F16) {
            mask = ggml_cast(m, mask, GGML_TYPE_F16);
        }

        x = ggml_flash_attn_ext(m, q, k, v, mask, scale, 0.0f, 0.0f);
        ggml_flash_attn_ext_set_prec(x, GGML_PREC_F32);

    } else {
        v = ggml_cont(m, ggml_permute(m, v, 1, 2, 0, 3));

        tensor attn = ggml_mul_mat(m, k, q);
        attn = ggml_soft_max_ext(m, attn, mask, scale, 0.0f);
        x = ggml_mul_mat(m, v, attn);

        x = ggml_cont(m, ggml_permute(m, x, 0, 2, 1, 3));
    }

    // [head_dim, n_heads, n_patches, batch] -> [embed_dim, n_patches, batch]
    x = ggml_reshape_3d(m, x, x->ne[0] * x->ne[1], x->ne[2], x->ne[3]);
    x = linear(m_out, x);

    return named(m, x);
}

} // namespace visp
