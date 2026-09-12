const UNIFORM_CAPACITY = 1024 * 1024;

export class Gpu {
  readonly uniforms: GPUBuffer;
  readonly uniformData = new Float32Array(UNIFORM_CAPACITY / 4);

  private constructor(readonly device: GPUDevice, readonly adapter: GPUAdapter) {
    this.uniforms = device.createBuffer({ label: 'Frame uniforms', size: UNIFORM_CAPACITY, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  static async create(): Promise<Gpu> {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. This editor requires a WebGPU-capable GPU and driver.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
    });
    return new Gpu(device, adapter);
  }

  beginFrame(): GpuFrame { return new GpuFrame(this); }
}

export class GpuFrame {
  readonly encoder: GPUCommandEncoder;
  private uniformBytes = 0;
  private retired: (GPUTexture | GPUBuffer)[] = [];

  constructor(readonly gpu: Gpu) {
    this.encoder = gpu.device.createCommandEncoder({ label: 'Editor update' });
  }

  uniform(values: readonly number[]): GPUBufferBinding {
    const alignment = this.gpu.device.limits.minUniformBufferOffsetAlignment;
    const offset = Math.ceil(this.uniformBytes / alignment) * alignment;
    const size = Math.ceil(values.length / 4) * 16;
    if (offset + size > UNIFORM_CAPACITY) throw new Error('Too many drawing commands in one frame.');
    this.gpu.uniformData.set(values, offset / 4);
    this.uniformBytes = offset + size;
    return { buffer: this.gpu.uniforms, offset, size };
  }

  upload(data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.gpu.device.createBuffer({ size: Math.max(4, data.byteLength), usage, mappedAtCreation: true });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    this.retired.push(buffer);
    return buffer;
  }

  retire(resource: GPUTexture | GPUBuffer): void { this.retired.push(resource); }

  submit(): void {
    if (this.uniformBytes > 0) {
      this.gpu.device.queue.writeBuffer(this.gpu.uniforms, 0, this.gpu.uniformData.buffer, 0, this.uniformBytes);
    }
    this.gpu.device.queue.submit([this.encoder.finish()]);
    this.release();
  }

  release(): void {
    for (const resource of this.retired) resource.destroy();
    this.retired = [];
  }
}
