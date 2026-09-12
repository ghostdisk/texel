struct Bounds {
  left: atomic<u32>,
  top: atomic<u32>,
  right: atomic<u32>,
  bottom: atomic<u32>,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> bounds: Bounds;
var<workgroup> tileBounds: Bounds;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) invocation: vec3u, @builtin(local_invocation_index) index: u32) {
  let size = textureDimensions(source);
  if (index == 0u) {
    atomicStore(&tileBounds.left, size.x);
    atomicStore(&tileBounds.top, size.y);
    atomicStore(&tileBounds.right, 0u);
    atomicStore(&tileBounds.bottom, 0u);
  }
  workgroupBarrier();
  if (all(invocation.xy < size)) {
    if (textureLoad(source, vec2i(invocation.xy), 0).a > 0.0) {
      atomicMin(&tileBounds.left, invocation.x);
      atomicMin(&tileBounds.top, invocation.y);
      atomicMax(&tileBounds.right, invocation.x + 1u);
      atomicMax(&tileBounds.bottom, invocation.y + 1u);
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
