import type { Surface } from '../gpu/surface';
import type { FilterRenderContext } from './filter';

const pipelines = new WeakMap<GPUDevice, Map<string, GPUComputePipeline>>();

/** Shared dispatch only; each filter supplies its own WGSL and parameters. */
export function renderComputeFilter(
  context: FilterRenderContext, input: Surface, code: string, parameters: readonly number[], label: string,
): Surface {
  const { device } = context.gpu;
  let cache = pipelines.get(device);
  if (!cache) { cache = new Map(); pipelines.set(device, cache); }
  let pipeline = cache.get(code);
  if (!pipeline) {
    pipeline = device.createComputePipeline({
      label,
      layout: 'auto',
      compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    });
    cache.set(code, pipeline);
  }
  const output = context.surface('output', input.bounds, input.scale);
  const params = context.frame.uniform(parameters);
  const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: input.view },
    { binding: 1, resource: output.view },
    { binding: 2, resource: params },
  ] });
  const pass = context.frame.encoder.beginComputePass({ label });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindings);
  pass.dispatchWorkgroups(Math.ceil(output.texture.width / 8), Math.ceil(output.texture.height / 8));
  pass.end();
  return output;
}
