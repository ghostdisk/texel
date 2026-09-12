struct Params {
  singleChannel: f32,
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> occupied: atomic<u32>;
@group(0) @binding(2) var<uniform> params: Params;
var<workgroup> tileOccupied: atomic<u32>;

@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) local: u32) {
  if (local == 0) { atomicStore(&tileOccupied, 0); }
  workgroupBarrier();
  if (all(id.xy < textureDimensions(source))) {
    let pixel = textureLoad(source, id.xy, 0);
    if (select(pixel.a, pixel.r, params.singleChannel > 0.5) > 0.0) { atomicOr(&tileOccupied, 1); }
  }
  workgroupBarrier();
  if (local == 0 && atomicLoad(&tileOccupied) != 0) { atomicOr(&occupied, 1); }
}
