@group(0) @binding(0) var selection: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination);
  if (any(id.xy >= size)) { return; }
  let sourceSize = textureDimensions(selection);
  let start = id.xy * sourceSize / size;
  let end = min(sourceSize, ((id.xy + vec2u(1)) * sourceSize + size - vec2u(1)) / size);
  var coverage = 0.0;
  for (var y = start.y; y < end.y && coverage == 0.0; y++) {
    for (var x = start.x; x < end.x; x++) {
      if (textureLoad(selection, vec2i(i32(x), i32(y)), 0).r > 0.0) {
        coverage = 1.0;
        break;
      }
    }
  }
  textureStore(destination, id.xy, vec4f(coverage, coverage, coverage, 1.0));
}
