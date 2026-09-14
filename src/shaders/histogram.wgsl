@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>, 256>;
struct Params {
  clip: vec4f,
  mode: vec4f,
}
@group(0) @binding(2) var<uniform> params: Params;
var<workgroup> bins: array<atomic<u32>, 256>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) invocation: vec3u, @builtin(local_invocation_index) index: u32) {
  atomicStore(&bins[index], 0u);
  workgroupBarrier();
  if (all(vec2f(invocation.xy) >= params.clip.xy) && all(vec2f(invocation.xy) < params.clip.zw)) {
    var pixel = loadTile(source, vec2i(invocation.xy));
    if (params.mode.x > 0.5) { pixel = vec4f(pixel.rrr, 1); }
    if (pixel.a > 0.0) {
      let value = max(pixel.rgb / pixel.a, vec3f(0));
      let rgb = select(1.055 * pow(value, vec3f(1.0 / 2.4)) - 0.055, value * 12.92, value <= vec3f(0.0031308));
      let slots = vec3u(round(clamp(rgb, vec3f(0), vec3f(1)) * 255.0));
      atomicAdd(&bins[slots.r], 1u);
      atomicAdd(&bins[slots.g], 1u);
      atomicAdd(&bins[slots.b], 1u);
    }
  }
  workgroupBarrier();
  atomicAdd(&histogram[index], atomicLoad(&bins[index]));
}

