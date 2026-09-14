struct Params {
  settings: vec4f,
  weights: array<vec4f, 65>,
}

@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: Params;

var<workgroup> tile: array<vec4f, 640>;

fn weight(index: u32) -> f32 {
  return params.weights[index / 4u][index % 4u];
}

@compute @workgroup_size(128) fn main(
  @builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_id) local: vec3u,
) {
  let size = vec2i(textureDimensions(destination));
  let radius = u32(params.settings.y);
  let vertical = params.settings.x > 0.5;
  let origin = i32(group.x * 128u) - i32(radius);
  for (var index = local.x; index < 128u + 2u * radius; index += 128u) {
    let position = select(vec2i(origin + i32(index), i32(group.y)), vec2i(i32(group.y), origin + i32(index)), vertical);
    tile[index] = loadSource(vec2i(position));
  }
  workgroupBarrier();
  let along = group.x * 128u + local.x;
  let position = select(vec2u(along, group.y), vec2u(group.y, along), vertical);
  if (any(position >= vec2u(size))) { return; }
  let center = local.x + radius;
  var color = tile[center] * weight(0u);
  for (var index = 1u; index <= radius; index++) {
    color += (tile[center - index] + tile[center + index]) * weight(index);
  }
  storeDestination(vec2i(position), color);
}
