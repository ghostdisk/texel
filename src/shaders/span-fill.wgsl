struct Params {
  size: vec4f,
  mode: vec4f,
  seedColor: vec4f,
  state: vec4f,
  seedPixel: vec4f,
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var selection: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> parents: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> reached: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> entries: array<u32>;
@group(0) @binding(6) var<storage, read_write> summary: array<atomic<u32>>;
@group(0) @binding(7) var destination: texture_storage_2d<rgba16float, write>;

const ABSENT = 0xffffffffu;

fn colorAt(position: vec2u) -> vec4f {
  let pixel = loadTile(source, vec2i(position));
  if (params.mode.y > 0.5) { return vec4f(pixel.rrr, 1); }
  if (pixel.a <= 0.0) { return vec4f(0); }
  let linear = max(pixel.rgb / pixel.a, vec3f(0));
  let srgb = select(1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055, linear * 12.92, linear <= vec3f(0.0031308));
  return vec4f(clamp(srgb, vec3f(0), vec3f(1)), pixel.a);
}

fn selected(position: vec2u) -> bool {
  if (params.mode.z < 0.5) { return true; }
  let mask = loadTile(selection, vec2i(position));
  return select(mask.a, mask.r, params.mode.w > 0.5) > 0.0;
}

@compute @workgroup_size(1) fn sampleSeed() {
  let position = vec2u(params.size.zw);
  let color = colorAt(position);
  for (var channel = 0u; channel < 4u; channel++) { atomicStore(&summary[channel], bitcast<u32>(color[channel])); }
  atomicStore(&summary[4], select(0u, 1u, selected(position)));
  let pixel = loadTile(source, vec2i(position));
  for (var channel = 0u; channel < 4u; channel++) { atomicStore(&summary[5u + channel], bitcast<u32>(pixel[channel])); }
}

@compute @workgroup_size(8, 8) fn initialize(@builtin(global_invocation_id) id: vec3u) {
  let index = id.y * 256u + id.x;
  var matches = false;
  if (all(id.xy < vec2u(params.size.xy)) && selected(id.xy)) {
    let difference = abs(colorAt(id.xy) - params.seedColor);
    matches = all(loadTile(source, vec2i(id.xy)) == params.seedPixel) || max(max(difference.r, difference.g), max(difference.b, difference.a)) <= params.mode.x;
  }
  atomicStore(&parents[index], select(ABSENT, index, matches));
}

// Monotonically decreasing parent pointers cannot form cycles. Path halving bounds long chains.
fn root(index: u32) -> u32 {
  var current = index;
  loop {
    let parent = atomicLoad(&parents[current]);
    if (parent == current) { return current; }
    let grandparent = atomicLoad(&parents[parent]);
    atomicMin(&parents[current], grandparent);
    current = parent;
  }
}

fn unite(first: u32, second: u32) {
  if (atomicLoad(&parents[second]) == ABSENT) { return; }
  loop {
    let a = root(first);
    let b = root(second);
    if (a == b) { return; }
    let high = max(a, b);
    let low = min(a, b);
    if (atomicCompareExchangeWeak(&parents[high], high, low).exchanged) { return; }
  }
}

// Eight-connected pixels, matching the chunk graph. Each connection is visited once.
@compute @workgroup_size(8, 8) fn connect(@builtin(global_invocation_id) id: vec3u) {
  let index = id.y * 256u + id.x;
  if (atomicLoad(&parents[index]) == ABSENT) { return; }
  if (id.x > 0u) { unite(index, index - 1u); }
  if (id.y > 0u) {
    unite(index, index - 256u);
    if (id.x > 0u) { unite(index, index - 257u); }
    if (id.x + 1u < u32(params.size.x)) { unite(index, index - 255u); }
  }
}

fn entered(edge: u32) -> bool { return (entries[edge >> 5u] & (1u << (edge & 31u))) != 0u; }

@compute @workgroup_size(8, 8) fn seedComponents(@builtin(global_invocation_id) id: vec3u) {
  let index = id.y * 256u + id.x;
  if (atomicLoad(&parents[index]) == ABSENT) { return; }
  let size = vec2u(params.size.xy);
  let entryFlags = u32(params.state.z);
  var seeded = params.state.y < 0.5 || i32(index) == i32(params.state.x);
  if (id.x == 0u && ((entryFlags & 1u) != 0u || entered(id.y))) { seeded = true; }
  if (id.x + 1u == size.x && ((entryFlags & 2u) != 0u || entered(256u + id.y))) { seeded = true; }
  if (id.y == 0u && ((entryFlags & 4u) != 0u || entered(512u + id.x))) { seeded = true; }
  if (id.y + 1u == size.y && ((entryFlags & 8u) != 0u || entered(768u + id.x))) { seeded = true; }
  if (id.x == 0u && id.y == 0u && (entryFlags & 16u) != 0u) { seeded = true; }
  if (id.x + 1u == size.x && id.y == 0u && (entryFlags & 32u) != 0u) { seeded = true; }
  if (id.x == 0u && id.y + 1u == size.y && (entryFlags & 64u) != 0u) { seeded = true; }
  if (id.x + 1u == size.x && id.y + 1u == size.y && (entryFlags & 128u) != 0u) { seeded = true; }
  if (seeded) {
    let component = root(index);
    atomicOr(&reached[component >> 5u], 1u << (component & 31u));
  }
}

fn emit(edge: u32) { atomicOr(&summary[edge >> 5u], 1u << (edge & 31u)); }

@compute @workgroup_size(8, 8) fn coverage(@builtin(global_invocation_id) id: vec3u) {
  let index = id.y * 256u + id.x;
  var filled = false;
  if (atomicLoad(&parents[index]) != ABSENT) {
    let component = root(index);
    filled = (atomicLoad(&reached[component >> 5u]) & (1u << (component & 31u))) != 0u;
  }
  textureStore(destination, id.xy, vec4f(select(0.0, 1.0, filled)));
  if (!filled) { return; }
  let size = vec2u(params.size.xy);
  if (id.x == 0u) { emit(id.y); }
  if (id.x + 1u == size.x) { emit(256u + id.y); }
  if (id.y == 0u) { emit(512u + id.x); }
  if (id.y + 1u == size.y) { emit(768u + id.x); }
  atomicMin(&summary[32], id.x);
  atomicMin(&summary[33], id.y);
  atomicMax(&summary[34], id.x + 1u);
  atomicMax(&summary[35], id.y + 1u);
  atomicAdd(&summary[36], 1u);
}
