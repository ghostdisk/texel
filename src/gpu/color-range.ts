import type { Point } from '../model/geometry';
import type { Gpu } from './device';
import { tileClip } from './local';
import { MASK_FORMAT, TILE_SIZE, createSurface, planTiles } from './surface';
import type { Surface } from './surface';
import { tileLoadShader } from './tile-sampling';

const sampleShader = `${tileLoadShader}
struct Params { values: vec4f }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> colors: array<vec4f>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(1) fn main() {
  let position = vec2i(floor(params.values.xy));
  var color = loadTile(source, position);
  if (color.a > 0.0) { color = vec4f(color.rgb / color.a, color.a); }
  colors[u32(params.values.z)] = color;
}`;

const maskShader = `${tileLoadShader}
struct Params {
  values: vec4f,
  clip: vec4f,
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> colors: array<vec4f>;
@group(0) @binding(2) var<uniform> params: Params;

fn oklab(rgb: vec3f) -> vec3f {
  let lms = mat3x3f(
    0.4122214708, 0.2119034982, 0.0883024619,
    0.5363325363, 0.6806995451, 0.2817188376,
    0.0514459929, 0.1073969566, 0.6299787005
  ) * rgb;
  let roots = sign(lms) * pow(abs(lms), vec3f(1.0 / 3.0));
  return mat3x3f(
    0.2104542553, 1.9779984951, 0.0259040371,
    0.7936177850, -2.4285922050, 0.7827717662,
    -0.0040720468, 0.4505937099, -0.8086757660
  ) * roots;
}

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let position = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(position[index], 0, 1);
}

@fragment fn fragmentMain(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let position = vec2i(pixel.xy);
  let center = pixel.xy;
  if (any(center < params.clip.xy) || any(center >= params.clip.zw)) { return vec4f(0); }
  let sourceColor = loadTile(source, position);
  let tolerance = 0.005 + params.values.y * 0.55;
  let softness = max(0.004, tolerance * 0.18);
  var coverage = 0.0;
  if (sourceColor.a > 0.0) {
    let color = oklab(sourceColor.rgb / sourceColor.a);
    for (var index = 0u; index < u32(params.values.x); index++) {
      if (colors[index].a <= 0.0) { continue; }
      let distance = length(color - oklab(colors[index].rgb));
      coverage = max(coverage, 1.0 - smoothstep(tolerance - softness, tolerance + softness, distance));
    }
  }
  let mask = coverage * sourceColor.a;
  return vec4f(select(mask, 1.0 - mask, params.values.z > 0.5), 0, 0, 1);
}`;

/** Samples point colors on the GPU, then produces a perceptual color-distance mask. */
export class ColorRangeRenderer {
  private readonly samplePipeline: GPUComputePipeline;
  private readonly maskPipeline: GPURenderPipeline;

  constructor(private readonly gpu: Gpu) {
    const sampleModule = gpu.device.createShaderModule({ label: 'Color range samples', code: sampleShader });
    this.samplePipeline = gpu.device.createComputePipeline({ label: 'Color range samples', layout: 'auto', compute: { module: sampleModule } });
    const maskModule = gpu.device.createShaderModule({ label: 'Color range mask', code: maskShader });
    this.maskPipeline = gpu.device.createRenderPipeline({
      label: 'Color range mask', layout: 'auto', vertex: { module: maskModule, entryPoint: 'vertexMain' },
      fragment: { module: maskModule, entryPoint: 'fragmentMain', targets: [{ format: MASK_FORMAT }] },
    });
  }

  render(source: Surface, points: readonly Point[], fuzziness: number, invert: boolean): Surface {
    const output = createSurface('Color range', source.bounds, 1, MASK_FORMAT);
    if ((!points.length || !source.tiles.size) && !invert) return output;
    const frame = this.gpu.beginFrame();
    const colors = this.gpu.device.createBuffer({ size: Math.max(16, points.length * 16), usage: GPUBufferUsage.STORAGE });
    try {
      const samplePass = frame.encoder.beginComputePass({ label: 'Sample color range points' });
      samplePass.setPipeline(this.samplePipeline);
      points.forEach((point, index) => {
        const px = point.x * source.scale, py = point.y * source.scale;
        const x = Math.floor(px / TILE_SIZE), y = Math.floor(py / TILE_SIZE);
        const inside = point.x >= source.bounds.x && point.y >= source.bounds.y && point.x < source.bounds.x + source.bounds.width && point.y < source.bounds.y + source.bounds.height;
        const params = frame.uniform([inside ? px - x * TILE_SIZE : -1, inside ? py - y * TILE_SIZE : -1, index, 0]);
        samplePass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.samplePipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: source.view(x, y) }, { binding: 1, resource: { buffer: colors } }, { binding: 2, resource: params },
        ] }));
        samplePass.dispatchWorkgroups(1);
      });
      samplePass.end();
      const regions = invert ? [output.bounds] : source.regions;
      for (const { x, y, bounds } of planTiles(output, regions).values()) {
        const tile = output.writable(frame, x, y, bounds);
        const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: tile.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        pass.setPipeline(this.maskPipeline);
        pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.maskPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: source.view(x, y) }, { binding: 1, resource: { buffer: colors } },
          { binding: 2, resource: frame.uniform([points.length, fuzziness / 200, Number(invert), 0, ...tileClip(output, tile)]) },
        ] }));
        pass.draw(3);
        pass.end();
      }
      frame.retire(colors);
      frame.submit();
      return output;
    } catch (error) {
      colors.destroy();
      output.destroy();
      frame.release();
      throw error;
    }
  }
}
