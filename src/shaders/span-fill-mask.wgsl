@group(0) @binding(0) var<storage, read> visited: array<u32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination);
  if (any(id.xy >= size)) { return; }
  let index = id.y * size.x + id.x;
  let coverage = select(0.0, 1.0, (visited[index >> 5u] & (1u << (index & 31u))) != 0u);
  textureStore(destination, id.xy, vec4f(coverage));
}
