import shader from '../shaders/selection-outline.wgsl?raw';
import { inverse, multiply } from '../model/geometry';
import type { Matrix, Rect } from '../model/geometry';
import type { Gpu, GpuFrame } from './device';
import { SOURCE_OVER, quads } from './quad';
import { planTiles, TILE_SIZE } from './surface';
import type { Surface } from './surface';
import { expandedRegions, neighborhoodEntries, neighborhoodShader } from './local';

export class SelectionOutline {
  private readonly pipeline: GPURenderPipeline;

  constructor(private readonly gpu: Gpu, format: GPUTextureFormat) {
    const module = gpu.device.createShaderModule({ label: 'Selection coverage outline', code: neighborhoodShader() + shader });
    this.pipeline = gpu.device.createRenderPipeline({
      layout: 'auto', vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format, blend: SOURCE_OVER }] },
    });
  }

  encode(frame: GpuFrame, mask: Surface, worldToMask: Matrix, view: GPUTextureView, viewport: Rect, canvas: Rect, pixelsPerUnit: number, editing: boolean): void {
    const width = Math.max(1, Math.round(viewport.width * pixelsPerUnit)), height = Math.max(1, Math.round(viewport.height * pixelsPerUnit));
    const screen: Matrix = [pixelsPerUnit, 0, 0, pixelsPerUnit, -viewport.x * pixelsPerUnit, -viewport.y * pixelsPerUnit];
    const sampled = quads.region(frame, mask, { x: 0, y: 0, width, height }, 1, multiply(screen, inverse(worldToMask)));
    const planned = planTiles(sampled, expandedRegions(sampled, 1));
    const pass = frame.encoder.beginRenderPass({ label: 'Selection overlay', colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.pipeline);
    for (const { x, y } of planned.values()) {
      const params = frame.uniform([
        0, 0, width, height, (canvas.x - viewport.x) * pixelsPerUnit, (canvas.y - viewport.y) * pixelsPerUnit, canvas.width * pixelsPerUnit, canvas.height * pixelsPerUnit,
        0, 0, width, height, 1, 0, 0, 0, 0, 1, 0, 0, 1, performance.now() / 1000, Number(editing), 0,
        x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE,
      ]);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 2, resource: params }] }));
      pass.setBindGroup(1, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(1), entries: neighborhoodEntries(frame, sampled, x, y) }));
      pass.draw(6);
    }
    pass.end();
  }
}
