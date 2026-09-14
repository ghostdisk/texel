import { tileLoadShader } from './tile-sampling';
import { tileClip } from './local';
import blendShader from '../shaders/blend.wgsl?raw';
import { BLEND_MODES } from '../model/layers';
import type { BlendMode } from '../model/layers';
import { inverse } from '../model/geometry';
import type { Matrix } from '../model/geometry';
import { isMaskSurface, WORKING_FORMAT, planTiles, intersectBounds } from './surface';
import type { Surface } from './surface';
import { quads } from './quad';
import type { Gpu, GpuFrame } from './device';

export class BlendCompositor {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly pointSampler: GPUSampler;

  constructor(private readonly gpu: Gpu) {
    const { device } = gpu;
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ] });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.pointSampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
    const module = device.createShaderModule({ label: 'Shader blend modes', code: tileLoadShader + blendShader });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: WORKING_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  encode(
    frame: GpuFrame, backdrop: Surface, source: Surface, target: Surface, matrix: Matrix,
    opacity: number, mode: BlendMode, pointSampling = false,
  ): void {
    const aligned = target.scratch(frame, 'blend-source');
    const draw = quads.begin(frame, aligned);
    quads.draw(draw, frame, source, aligned, matrix, 1, 'normal', false, pointSampling);
    draw.end();
    const planned = planTiles(target, [...backdrop.regions, ...aligned.regions]);
    target.retain(new Set(planned.keys()), frame);
    for (const [key, { x, y, bounds }] of planned) {
      const signature = JSON.stringify([backdrop.tile(x, y)?.revision ?? 0, aligned.tile(x, y)?.revision ?? 0, opacity, mode, bounds]);
      if (target.tiles.get(key)?.signature === signature) continue;
      const tile = target.writable(frame, x, y, bounds);
      const dst = tile.bounds;
      const params = frame.uniform([
        1, 0, 0, 0, 0, 1, 0, 0, dst.x, dst.y, dst.width, dst.height, dst.x, dst.y, dst.width, dst.height,
        opacity, BLEND_MODES.indexOf(mode), 0, target.scale, ...tileClip(backdrop, tile), ...tileClip(aligned, tile),
      ]);
      const bindGroup = this.gpu.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: backdrop.view(x, y) }, { binding: 1, resource: aligned.view(x, y) },
        { binding: 2, resource: this.pointSampler }, { binding: 3, resource: params },
      ] });
      const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: tile.view, loadOp: 'clear', storeOp: 'store' }] });
      const clip = intersectBounds(tile.bounds, target.bounds)!;
      pass.setScissorRect(Math.round((clip.x - tile.bounds.x) * target.scale), Math.round((clip.y - tile.bounds.y) * target.scale), Math.round(clip.width * target.scale), Math.round(clip.height * target.scale));
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      tile.signature = signature;
    }
  }
}
