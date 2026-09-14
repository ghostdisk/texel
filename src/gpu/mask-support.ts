import { tileLoadShader } from './tile-sampling';
import { tileClip } from './local';
import { device } from './device';
import type { GpuFrame } from './device';
import { TILE_SIZE, planTiles } from './surface';
import type { Surface, Tile } from './surface';
import { transformBounds } from '../model/geometry';
import type { Matrix } from '../model/geometry';

const shader = `
struct Params {
  source: vec4f,
  target: vec4f,
  scale: vec4f,
  quad: vec4f,
  clip: vec4f,
}
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;
struct Vertex {
  @builtin(position) position: vec4f,
}
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> Vertex {
  let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let pixel = params.quad.xy + corners[index] * params.quad.zw;
  let clip = (pixel - params.target.xy) / params.target.zw * 2 - 1;
  return Vertex(vec4f(clip.x, -clip.y, 0, 1));
}
@fragment fn fragmentMain(input: Vertex) -> @location(0) vec4f {
  let pixel = floor(input.position.xy) + params.target.xy;
  let first = max(vec2i(floor(pixel * params.scale.xy + params.scale.zw - params.source.xy)), max(vec2i(0), vec2i(params.clip.xy)));
  let last = min(vec2i(ceil((pixel + 1) * params.scale.xy + params.scale.zw - params.source.xy)), min(vec2i(256), vec2i(params.clip.zw)));
  for (var y = first.y; y < last.y; y++) {
    for (var x = first.x; x < last.x; x++) {
      if (loadTile(image, vec2i(x, y)).r > 0.0) { return vec4f(1); }
    }
  }
  return vec4f(0);
}`;

let pipeline: GPURenderPipeline | null = null;

/** Conservative resize: even subpixel coverage survives when its source tile is minified. */
export function resizeMaskSupport(frame: GpuFrame, source: Surface, output: Surface): void {
  if (!pipeline) {
    const module = device.createShaderModule({ code: tileLoadShader + shader });
    const blend: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'max' };
    pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba16float', blend: { color: blend, alpha: blend } }] } });
  }
  const sx = output.width / source.width, sy = output.height / source.height;
  const matrix: Matrix = [sx * source.scale, 0, 0, sy * source.scale, -source.bounds.x * source.scale * sx, -source.bounds.y * source.scale * sy];
  const sources = new Map<string, Tile[]>();
  for (const tile of source.tiles.values()) for (const [key] of planTiles(output, [transformBounds(matrix, tile.contentBounds)])) {
    const list = sources.get(key) ?? [];
    list.push(tile);
    sources.set(key, list);
  }
  const planned = planTiles(output, source.regions.map((bounds) => transformBounds(matrix, bounds)));
  for (const [key, region] of planned) {
    const target = output.writable(frame, region.x, region.y, region.bounds);
    const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    for (const tile of sources.get(key) ?? []) {
      const bounds = transformBounds(matrix, tile.bounds);
      const params = frame.uniform([
        tile.x * TILE_SIZE, tile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE, target.bounds.x, target.bounds.y, TILE_SIZE, TILE_SIZE,
        1 / sx, 1 / sy, source.bounds.x * source.scale, source.bounds.y * source.scale,
        bounds.x - 0.5, bounds.y - 0.5, bounds.width + 1, bounds.height + 1, ...tileClip(source, tile),
      ]);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: tile.view }, { binding: 1, resource: params }] }));
      pass.draw(6);
    }
    pass.end();
  }
}
