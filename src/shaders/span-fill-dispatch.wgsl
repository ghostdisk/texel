struct QueueState {
  head: u32,
  tail: atomic<u32>,
}
@group(0) @binding(0) var<storage, read_write> state: QueueState;
@group(0) @binding(1) var<storage, read_write> arguments: array<u32>;

@compute @workgroup_size(1)
fn main() {
  arguments[0] = select(0u, 1u, atomicLoad(&state.tail) > state.head);
  arguments[1] = 1u;
  arguments[2] = 1u;
}
