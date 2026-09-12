import shader from '../shaders/brush.wgsl?raw';
import { SOURCE_OVER } from './quad';
import { WORKING_FORMAT } from './surface';
import type { Surface } from './surface';
import type { Gpu, GpuFrame } from './device';

export interface OperationContext {
  readonly frame: GpuFrame;
  readonly target: Surface;
}

export interface RenderOperation {
  encode(pass: GPURenderPassEncoder, context: OperationContext): void;
}

export interface BrushStamp {
  x: number;
  y: number;
  radius: number;
  hardness: number;
  color: readonly [number, number, number, number];
}

export class Brush {
  private readonly pipeline: GPURenderPipeline;

  constructor(private readonly gpu: Gpu) {
    const module = gpu.device.createShaderModule({ label: 'Brush stamps', code: shader });
    this.pipeline = gpu.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vertexMain',
        buffers: [{ arrayStride: 32, stepMode: 'instance', attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
        ] }],
      },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: WORKING_FORMAT, blend: SOURCE_OVER }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  operation(stamps: readonly BrushStamp[]): RenderOperation {
    return { encode: (pass, { frame, target }) => {
      if (stamps.length === 0) return;
      const data = new Float32Array(stamps.length * 8);
      stamps.forEach((stamp, index) => {
        data.set([stamp.x, stamp.y, stamp.radius, stamp.hardness, ...stamp.color], index * 8);
      });
      const instances = frame.upload(data, GPUBufferUsage.VERTEX);
      const params = frame.uniform([target.texture.width, target.texture.height, 0, 0]);
      const group = this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: params }] });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, instances);
      pass.draw(6, stamps.length);
    } };
  }
}
