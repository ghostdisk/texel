const SINGLE_CHANNEL = false;
struct Bounds {
  left: atomic<u32>,
  top: atomic<u32>,
  right: atomic<u32>,
  bottom: atomic<u32>,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> bounds: Bounds;
@group(0) @binding(2) var<uniform> tile: vec4f;
var<workgroup> tileBounds: Bounds;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) invocation: vec3u, @builtin(local_invocation_index) index: u32) {
  let size = vec2u(256);
  if (index == 0u) {
    atomicStore(&tileBounds.left, u32(tile.z));
    atomicStore(&tileBounds.top, u32(tile.w));
    atomicStore(&tileBounds.right, 0u);
    atomicStore(&tileBounds.bottom, 0u);
  }
  workgroupBarrier();
  let position = vec2i(invocation.xy) + vec2i(tile.xy);
  if (all(invocation.xy < size) && all(position >= vec2i(0)) && all(position < vec2i(tile.zw))) {
    let pixel = loadTile(source, vec2i(vec2i(invocation.xy)));
    if (select(pixel.a, pixel.r, SINGLE_CHANNEL) > 0.0) {
      atomicMin(&tileBounds.left, u32(position.x));
      atomicMin(&tileBounds.top, u32(position.y));
      atomicMax(&tileBounds.right, u32(position.x) + 1u);
      atomicMax(&tileBounds.bottom, u32(position.y) + 1u);
    }
  }
  workgroupBarrier();
  if (index == 0u && atomicLoad(&tileBounds.right) > 0u) {
    atomicMin(&bounds.left, atomicLoad(&tileBounds.left));
    atomicMin(&bounds.top, atomicLoad(&tileBounds.top));
    atomicMax(&bounds.right, atomicLoad(&tileBounds.right));
    atomicMax(&bounds.bottom, atomicLoad(&tileBounds.bottom));
  }
}
