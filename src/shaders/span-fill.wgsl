struct Params {
  size: vec4u,
  mode: vec4f,
  row0: vec4f,
  row1: vec4f,
  maskBounds: vec4f,
}
struct Span {
  start: u32,
  end: u32,
}
struct QueueState {
  head: u32,
  tail: atomic<u32>,
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var selectionImage: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var<storage, read_write> matching: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> visited: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> queue: array<Span>;
@group(0) @binding(7) var<storage, read_write> state: QueueState;

fn colorAt(point: vec2u) -> vec4f {
  let pixel = textureLoad(source, vec2i(point), 0);
  if (params.mode.y > 0.5) { return vec4f(pixel.rrr, 1); }
  if (pixel.a <= 0.0) { return vec4f(0); }
  let color = max(pixel.rgb / pixel.a, vec3f(0));
  let srgb = select(1.055 * pow(color, vec3f(1.0 / 2.4)) - 0.055, color * 12.92, color <= vec3f(0.0031308));
  return vec4f(clamp(srgb, vec3f(0), vec3f(1)), pixel.a);
}

fn inSelection(point: vec2u) -> bool {
  if (params.mode.z < 0.5) { return true; }
  let position = vec3f(vec2f(point) + 0.5, 1);
  let local = vec2f(dot(params.row0.xyz, position), dot(params.row1.xyz, position));
  let uv = (local - params.maskBounds.xy) / params.maskBounds.zw;
  if (any(uv < vec2f(0)) || any(uv >= vec2f(1))) { return false; }
  let mask = textureSampleLevel(selectionImage, imageSampler, uv, 0);
  return select(mask.a, mask.r, params.mode.w > 0.5) > 0.0;
}

@compute @workgroup_size(8, 8)
fn matchPixels(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size.xy)) { return; }
  if (!inSelection(params.size.zw)) { return; }
  let difference = abs(colorAt(id.xy) - colorAt(params.size.zw));
  if (max(max(difference.r, difference.g), max(difference.b, difference.a)) > params.mode.x || !inSelection(id.xy)) { return; }
  let index = id.y * params.size.x + id.x;
  atomicOr(&matching[index >> 5u], 1u << (index & 31u));
}

fn lowBits(count: u32) -> u32 {
  if (count >= 32u) { return 0xffffffffu; }
  return (1u << count) - 1u;
}

// Runs are maximal within a row, giving every run a unique claim bit at its start.
fn expand(index: u32) -> Span {
  let rowStart = index / params.size.x * params.size.x;
  let rowEnd = rowStart + params.size.x - 1u;
  var left = index;
  loop {
    let base = left & ~31u;
    let first = max(base, rowStart);
    let range = lowBits((left & 31u) + 1u) & (0xffffffffu << (first & 31u));
    let gaps = ~atomicLoad(&matching[left >> 5u]) & range;
    if (gaps != 0u) { left = base + firstLeadingBit(gaps) + 1u; break; }
    left = first;
    if (left == rowStart) { break; }
    left--;
  }
  var right = index;
  loop {
    let base = right & ~31u;
    let last = min(base + 31u, rowEnd);
    let range = (0xffffffffu << (right & 31u)) & lowBits((last & 31u) + 1u);
    let gaps = ~atomicLoad(&matching[right >> 5u]) & range;
    if (gaps != 0u) { right = base + firstTrailingBit(gaps) - 1u; break; }
    right = last;
    if (right == rowEnd) { break; }
    right++;
  }
  return Span(left, right);
}

fn enqueue(span: Span) {
  let bit = 1u << (span.start & 31u);
  if ((atomicOr(&visited[span.start >> 5u], bit) & bit) != 0u) { return; }
  // Only the owner of the run publishes it. Word operations also mark its full coverage.
  for (var word = span.start >> 5u; word <= (span.end >> 5u); word++) {
    let base = word * 32u;
    let first = max(span.start, base) - base;
    let last = min(span.end, base + 31u) - base;
    atomicOr(&visited[word], (0xffffffffu << first) & lowBits(last + 1u));
  }
  let slot = atomicAdd(&state.tail, 1u);
  queue[slot] = span;
}

@compute @workgroup_size(1)
fn seed() {
  let index = params.size.w * params.size.x + params.size.z;
  if ((atomicLoad(&matching[index >> 5u]) & (1u << (index & 31u))) != 0u) { enqueue(expand(index)); }
}

fn scanNeighbor(first: u32, last: u32) {
  var cursor = first;
  loop {
    if (cursor > last) { break; }
    let word = cursor >> 5u;
    let base = word * 32u;
    let end = min(last, base + 31u);
    let range = (0xffffffffu << (cursor & 31u)) & lowBits((end & 31u) + 1u);
    let available = atomicLoad(&matching[word]) & ~atomicLoad(&visited[word]) & range;
    if (available == 0u) { cursor = end + 1u; continue; }
    let span = expand(base + firstTrailingBit(available));
    enqueue(span);
    cursor = span.end + 1u;
  }
}

var<workgroup> batchStart: u32;
var<workgroup> batchSize: u32;

// One workgroup owns a bounded queue batch: no cross-workgroup waiting or barriers.
// A nonempty dispatch consumes 512 runs or exhausts the entire reachable component.
@compute @workgroup_size(64)
fn advance(@builtin(local_invocation_index) lane: u32) {
  var processed = 0u;
  loop {
    if (lane == 0u) {
      batchStart = state.head;
      batchSize = min(min(atomicLoad(&state.tail) - state.head, 64u), 512u - processed);
      state.head += batchSize;
    }
    let count = workgroupUniformLoad(&batchSize);
    let start = workgroupUniformLoad(&batchStart);
    if (count == 0u) { break; }
    if (lane < count) {
      let span = queue[start + lane];
      if (span.start >= params.size.x) { scanNeighbor(span.start - params.size.x, span.end - params.size.x); }
      if (span.end + params.size.x < params.size.x * params.size.y) { scanNeighbor(span.start + params.size.x, span.end + params.size.x); }
    }
    storageBarrier();
    processed += count;
    if (processed == 512u) { break; }
  }
}
