const UNIFORM_CAPACITY = 1024 * 1024;
export let device: GPUDevice;

export class Gpu {

  get device(): GPUDevice { return device; }

  private constructor(readonly adapter: GPUAdapter) {}

  static async create(): Promise<Gpu> {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. This editor requires a WebGPU-capable GPU and driver.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
    });
    return new Gpu(adapter);
  }

  beginFrame(): GpuFrame { return new GpuFrame(this); }
}

export class GpuFrame {
  readonly encoder: GPUCommandEncoder;
  private readonly pages: {
    buffer: GPUBuffer;
    data: Float32Array;
    bytes: number;
  }[] = [];
  private retired: { destroy(): void }[] = [];
  private readonly commits: (() => void)[] = [];
  private readonly rollbacks: (() => void)[] = [];
  private submitted = false;

  constructor(readonly gpu: Gpu) {
    this.encoder = gpu.device.createCommandEncoder({ label: 'Editor update' });
  }

  uniform(values: readonly number[]): GPUBufferBinding {
    const alignment = device.limits.minUniformBufferOffsetAlignment;
    const size = Math.ceil(values.length / 4) * 16;
    if (size > UNIFORM_CAPACITY) throw new Error('Uniform block exceeds the frame page size.');
    let page = this.pages[this.pages.length - 1];
    let offset = page ? Math.ceil(page.bytes / alignment) * alignment : 0;
    if (!page || offset + size > UNIFORM_CAPACITY) {
      page = { buffer: device.createBuffer({ label: 'Tile frame uniforms', size: UNIFORM_CAPACITY, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        data: new Float32Array(UNIFORM_CAPACITY / 4), bytes: 0 };
      this.pages.push(page);
      offset = 0;
    }
    page.data.set(values, offset / 4);
    page.bytes = offset + size;
    return { buffer: page.buffer, offset, size };
  }

  upload(data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.gpu.device.createBuffer({ size: Math.max(4, data.byteLength), usage, mappedAtCreation: true });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    this.retired.push(buffer);
    return buffer;
  }

  retire(resource: { destroy(): void }): void { this.retired.push(resource); }

  change(commit: () => void, rollback: () => void): void {
    this.commits.push(commit);
    this.rollbacks.push(rollback);
  }

  submit(): void {
    for (const page of this.pages) device.queue.writeBuffer(page.buffer, 0, page.data.buffer, 0, page.bytes);
    this.gpu.device.queue.submit([this.encoder.finish()]);
    this.submitted = true;
    for (const commit of this.commits) commit();
    this.commits.length = 0;
    this.rollbacks.length = 0;
    this.release();
  }

  release(): void {
    if (!this.submitted) for (const rollback of this.rollbacks.reverse()) rollback();
    this.rollbacks.length = 0;
    this.commits.length = 0;
    for (const page of this.pages) page.buffer.destroy();
    this.pages.length = 0;
    for (const resource of this.retired) resource.destroy();
    this.retired = [];
  }
}
