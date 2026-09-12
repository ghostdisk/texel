import behindShader from '../shaders/effect-behind.wgsl?raw';
import dilationShader from '../shaders/dilate-alpha.wgsl?raw';
import type { Gpu } from '../gpu/device';
import type { Surface } from '../gpu/surface';
import type { Point, Rect } from '../model/geometry';
import type { FilterRenderContext } from './filter';

const pipelines = new WeakMap<Gpu, Map<string, GPUComputePipeline>>();
const samplers = new WeakMap<Gpu, GPUSampler>();

function pipeline(gpu: Gpu, code: string, label: string): GPUComputePipeline {
  let cache = pipelines.get(gpu);
  if (!cache) { cache = new Map(); pipelines.set(gpu, cache); }
  let result = cache.get(code);
  if (!result) {
    result = gpu.device.createComputePipeline({ label, layout: 'auto', compute: { module: gpu.device.createShaderModule({ code }), entryPoint: 'main' } });
    cache.set(code, result);
  }
  return result;
}

export function dilateAlpha(context: FilterRenderContext, input: Surface, output: Surface, radius: number): void {
  const effect = pipeline(context.gpu, dilationShader, 'Round alpha border');
  const pass = context.frame.encoder.beginComputePass();
  pass.setPipeline(effect);
  pass.setBindGroup(0, context.gpu.device.createBindGroup({ layout: effect.getBindGroupLayout(0), entries: [
    { binding: 0, resource: input.view }, { binding: 1, resource: output.view }, { binding: 2, resource: context.frame.uniform([radius, 0, 0, 0]) },
  ] }));
  pass.dispatchWorkgroups(Math.ceil(output.texture.width / 8), Math.ceil(output.texture.height / 8));
  pass.end();
}

export function renderBehind(
  context: FilterRenderContext, source: Surface, mask: Surface, bounds: Rect,
  color: string, opacity: number, offset: Point = { x: 0, y: 0 }, outline = false,
): Surface {
  const { gpu, frame } = context;
  const effect = pipeline(gpu, behindShader, 'Composite alpha effect');
  let sampler = samplers.get(gpu);
  if (!sampler) { sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' }); samplers.set(gpu, sampler); }
  const output = context.surface('result', bounds, source.scale);
  const rgb = [1, 3, 5].map((index) => {
    const value = parseInt(color.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const rect = (value: Rect) => [value.x, value.y, value.width, value.height];
  const params = frame.uniform([...rect(source.bounds), ...rect(mask.bounds), ...rect(output.bounds), ...rgb, opacity, offset.x, offset.y, output.scale, Number(outline)]);
  const pass = frame.encoder.beginComputePass();
  pass.setPipeline(effect);
  pass.setBindGroup(0, gpu.device.createBindGroup({ layout: effect.getBindGroupLayout(0), entries: [
    { binding: 0, resource: source.view }, { binding: 1, resource: mask.view }, { binding: 2, resource: sampler },
    { binding: 3, resource: output.view }, { binding: 4, resource: params },
  ] }));
  pass.dispatchWorkgroups(Math.ceil(output.texture.width / 8), Math.ceil(output.texture.height / 8));
  pass.end();
  return output;
}

