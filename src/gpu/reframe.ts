import boundsShader from '../shaders/alpha-bounds.wgsl?raw';
import type { Matrix, Rect } from '../model/geometry';
import type { Gpu } from './device';
import type { QuadRenderer } from './quad';
import { createSurface } from './surface';
import type { Surface } from './surface';

/** Reframing keeps pixel data on the GPU; only the four occupied bounds are read back. */
export class LayerReframer {
  private boundsPipeline?: GPUComputePipeline;

  constructor(private readonly gpu: Gpu, private readonly quads: QuadRenderer) {}

  async contentBounds(source: Surface): Promise<Rect | null> {
    const { device } = this.gpu;
    this.boundsPipeline ??= device.createComputePipeline({
      label: 'Find nontransparent layer bounds',
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: boundsShader }), entryPoint: 'main' },
    });
    const reduction = device.createBuffer({ label: 'Layer bounds', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
    new Uint32Array(reduction.getMappedRange()).set([source.texture.width, source.texture.height, 0, 0]);
    reduction.unmap();
    const readback = device.createBuffer({ label: 'Layer bounds readback', size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const encoder = device.createCommandEncoder({ label: 'Measure layer content' });
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.boundsPipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: this.boundsPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: source.view },
        { binding: 1, resource: { buffer: reduction } },
      ] }));
      pass.dispatchWorkgroups(Math.ceil(source.texture.width / 16), Math.ceil(source.texture.height / 16));
      pass.end();
      encoder.copyBufferToBuffer(reduction, 0, readback, 0, 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const [left, top, right, bottom] = new Uint32Array(readback.getMappedRange());
      readback.unmap();
      if (right <= left || bottom <= top) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    } finally { reduction.destroy(); readback.destroy(); }
  }

  /** Integer crop/pad: copied texels stay bit-for-bit identical. New pixels are transparent. */
  resize(source: Surface, bounds: Rect): Surface {
    const output = createSurface(this.gpu.device, 'Reframed layer source', { x: 0, y: 0, width: bounds.width, height: bounds.height });
    try {
      const encoder = this.gpu.device.createCommandEncoder({ label: 'Crop and extend layer' });
      const left = Math.max(0, bounds.x);
      const top = Math.max(0, bounds.y);
      const right = Math.min(source.texture.width, bounds.x + bounds.width);
      const bottom = Math.min(source.texture.height, bounds.y + bounds.height);
      if (right > left && bottom > top) {
        encoder.copyTextureToTexture(
          { texture: source.texture, origin: { x: left, y: top } },
          { texture: output.texture, origin: { x: left - bounds.x, y: top - bounds.y } },
          { width: right - left, height: bottom - top },
        );
      }
      this.gpu.device.queue.submit([encoder.finish()]);
      return output;
    } catch (error) { output.texture.destroy(); throw error; }
  }

  /** Bake the source's world placement into one texel per canonical canvas pixel. */
  normalize(source: Surface, canvas: Rect, world: Matrix): Surface {
    const output = createSurface(this.gpu.device, 'Normalized layer source', canvas);
    const frame = this.gpu.beginFrame();
    try {
      const pass = this.quads.begin(frame, output);
      this.quads.draw(pass, frame, source, output, world);
      pass.end();
      frame.submit();
      return output;
    } catch (error) { output.texture.destroy(); frame.release(); throw error; }
  }
}
