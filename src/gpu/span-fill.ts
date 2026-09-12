import shader from '../shaders/span-fill.wgsl?raw';
import dispatchShader from '../shaders/span-fill-dispatch.wgsl?raw';
import maskShader from '../shaders/span-fill-mask.wgsl?raw';
import { IDENTITY } from '../model/geometry';
import type { Point } from '../model/geometry';
import type { Gpu } from './device';
import type { MaskInput } from './mask';
import { createSurface, isMaskSurface, MASK_FORMAT } from './surface';
import type { Surface } from './surface';

const SPANS_PER_DISPATCH = 512;
const DISPATCHES_PER_SUBMISSION = 128;

/** GPU-only region discovery. CPU scheduling uses a proven run bound, never queue readback. */
export class SpanFill {
  private readonly layout: GPUBindGroupLayout;
  private readonly match: GPUComputePipeline;
  private readonly seed: GPUComputePipeline;
  private readonly advance: GPUComputePipeline;
  private readonly indirect: GPUComputePipeline;
  private readonly mask: GPUComputePipeline;
  private readonly sampler: GPUSampler;
  private readonly empty: Surface;

  constructor(private readonly gpu: Gpu) {
    const device = gpu.device;
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: {} },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: {} },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ...[4, 5, 6, 7].map((binding): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } })),
    ] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const module = device.createShaderModule({ label: 'Span flood fill', code: shader });
    const pipeline = (entryPoint: string) => device.createComputePipeline({ layout, compute: { module, entryPoint } });
    this.match = pipeline('matchPixels');
    this.seed = pipeline('seed');
    this.advance = pipeline('advance');
    this.indirect = device.createComputePipeline({ layout: 'auto', compute: {
      module: device.createShaderModule({ label: 'Span queue dispatch', code: dispatchShader }), entryPoint: 'main',
    } });
    this.mask = device.createComputePipeline({ layout: 'auto', compute: {
      module: device.createShaderModule({ label: 'Fill coverage', code: maskShader }), entryPoint: 'main',
    } });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.empty = createSurface(device, 'Unused fill selection', { x: 0, y: 0, width: 1, height: 1 }, 1, MASK_FORMAT);
  }

  async region(source: Surface, point: Point, tolerance: number, contiguous: boolean, selection: MaskInput | null, signal: AbortSignal): Promise<Surface> {
    const device = this.gpu.device;
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    let result: Surface | undefined;
    let failure: unknown;
    try { result = await this.discover(source, point, tolerance, contiguous, selection, signal); }
    catch (error) { failure = error; }
    try {
      const [validation, memory] = await Promise.all([device.popErrorScope(), device.popErrorScope()]);
      failure ??= validation ? new Error('Fill failed: ' + validation.message) : memory ? new Error('Not enough GPU memory for this fill.') : undefined;
      signal.throwIfAborted();
    } catch (error) { failure ??= error; }
    if (failure || !result) { result?.texture.destroy(); throw failure ?? new Error('Fill produced no coverage.'); }
    return result;
  }

  private async discover(source: Surface, point: Point, tolerance: number, contiguous: boolean, selection: MaskInput | null, signal: AbortSignal): Promise<Surface> {
    const device = this.gpu.device;
    const width = source.texture.width, height = source.texture.height;
    const bitBytes = Math.ceil(width * height / 32) * 4;
    // Every maximal matching run needs a separating nonmatching pixel. Its start is claimed once.
    const maxSpans = Math.ceil(width / 2) * height;
    const queueBytes = contiguous ? maxSpans * 8 : 8;
    const bufferLimit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
    if (queueBytes > bufferLimit || bitBytes > bufferLimit) throw new Error('This layer is too large for a fill queue on this GPU.');
    const buffers: GPUBuffer[] = [];
    let output: GPUTexture | undefined;
    const allocate = (size: number, usage: GPUBufferUsageFlags, label: string) => {
      const buffer = device.createBuffer({ size, usage, label });
      buffers.push(buffer);
      return buffer;
    };
    try {
      signal.throwIfAborted();
      const matching = allocate(bitBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, 'Fill matching bits');
      const visited = allocate(bitBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'Fill visited bits');
      const queue = allocate(queueBytes, GPUBufferUsage.STORAGE, 'Fill span queue');
      const state = allocate(8, GPUBufferUsage.STORAGE, 'Fill span queue counters');
      const argumentsBuffer = allocate(12, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT, 'Fill indirect dispatch');
      const parameters = allocate(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'Fill parameters');
      const data = new ArrayBuffer(80);
      new Uint32Array(data, 0, 4).set([width, height, point.x, point.y]);
      const mask = selection?.surface ?? this.empty;
      const [a, b, c, d, e, f] = selection?.transform ?? IDENTITY;
      const bounds = mask.bounds;
      new Float32Array(data, 16).set([
        tolerance, Number(isMaskSurface(source)), Number(!!selection), Number(isMaskSurface(mask)),
        a, c, e, 0, b, d, f, 0, bounds.x, bounds.y, bounds.width, bounds.height,
      ]);
      device.queue.writeBuffer(parameters, 0, data);
      const bindings = device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: source.view }, { binding: 1, resource: mask.view }, { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: parameters } }, { binding: 4, resource: { buffer: matching } },
        { binding: 5, resource: { buffer: visited } }, { binding: 6, resource: { buffer: queue } }, { binding: 7, resource: { buffer: state } },
      ] });
      const dispatchBindings = device.createBindGroup({ layout: this.indirect.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: state } }, { binding: 1, resource: { buffer: argumentsBuffer } },
      ] });
      const initialization = device.createCommandEncoder({ label: 'Match fill source pixels' });
      const initialize = initialization.beginComputePass();
      initialize.setBindGroup(0, bindings);
      initialize.setPipeline(this.match);
      initialize.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      if (contiguous) { initialize.setPipeline(this.seed); initialize.dispatchWorkgroups(1); }
      initialize.end();
      if (!contiguous) initialization.copyBufferToBuffer(matching, 0, visited, 0, bitBytes);
      device.queue.submit([initialization.finish()]);
      await device.queue.onSubmittedWorkDone();

      // Each nonempty dispatch consumes 512 spans or drains the connected component. This
      // bounds even a one-pixel maze without mapping a counter or imposing a depth cutoff.
      const dispatches = contiguous ? Math.ceil(maxSpans / SPANS_PER_DISPATCH) : 0;
      for (let offset = 0; offset < dispatches; offset += DISPATCHES_PER_SUBMISSION) {
        signal.throwIfAborted();
        const encoder = device.createCommandEncoder({ label: 'Advance fill spans' });
        const count = Math.min(DISPATCHES_PER_SUBMISSION, dispatches - offset);
        for (let index = 0; index < count; index++) {
          const prepare = encoder.beginComputePass();
          prepare.setPipeline(this.indirect);
          prepare.setBindGroup(0, dispatchBindings);
          prepare.dispatchWorkgroups(1);
          prepare.end();
          const pass = encoder.beginComputePass();
          pass.setPipeline(this.advance);
          pass.setBindGroup(0, bindings);
          pass.dispatchWorkgroupsIndirect(argumentsBuffer, 0);
          pass.end();
        }
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
      }
      signal.throwIfAborted();
      output = device.createTexture({
        label: 'Completed fill coverage', size: { width, height }, format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      const view = output.createView();
      const maskBindings = device.createBindGroup({ layout: this.mask.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: visited } }, { binding: 1, resource: view },
      ] });
      const encoder = device.createCommandEncoder({ label: 'Finish fill mask' });
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.mask);
      pass.setBindGroup(0, maskBindings);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      signal.throwIfAborted();
      return { texture: output, view, bounds: source.bounds, scale: source.scale };
    } catch (error) { output?.destroy(); throw error; }
    finally { for (const buffer of buffers) buffer.destroy(); }
  }
}
