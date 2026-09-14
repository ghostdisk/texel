import { tileLoadShader } from './tile-sampling';
import boundsShader from '../shaders/alpha-bounds.wgsl?raw';
import type { Matrix, Rect } from '../model/geometry';
import type { Gpu } from './device';
import type { QuadRenderer } from './quad';
import { createSurface, isMaskSurface, TILE_SIZE, intersectBounds, planTiles, paintSolid } from './surface';
import type { Surface } from './surface';

/** Reframing keeps pixel data on the GPU; only the four occupied bounds are read back. */
export class LayerReframer {
  private boundsPipelines = new Map<boolean, GPUComputePipeline>();

  constructor(private readonly gpu: Gpu, private readonly quads: QuadRenderer) {}

  async contentBounds(source: Surface): Promise<Rect | null> {
    if (!source.tiles.size) return null;
    const { device } = this.gpu;
    const singleChannel = isMaskSurface(source);
    let pipeline = this.boundsPipelines.get(singleChannel);
    if (!pipeline) {
      const code = boundsShader.replace('const SINGLE_CHANNEL = false;', `const SINGLE_CHANNEL = ${singleChannel};`);
      pipeline = device.createComputePipeline({
        label: 'Find nontransparent layer bounds', layout: 'auto',
        compute: { module: device.createShaderModule({ code: tileLoadShader + code }), entryPoint: 'main' },
      });
      this.boundsPipelines.set(singleChannel, pipeline);
    }
    const reduction = device.createBuffer({ label: 'Layer bounds', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
    new Uint32Array(reduction.getMappedRange()).set([source.width, source.height, 0, 0]);
    reduction.unmap();
    const readback = device.createBuffer({ label: 'Layer bounds readback', size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const frame = this.gpu.beginFrame();
    try {
      const encoder = frame.encoder;
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      for (const tile of source.tiles.values()) {
        pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: tile.view }, { binding: 1, resource: { buffer: reduction } },
          { binding: 2, resource: frame.uniform([(tile.bounds.x - source.bounds.x) * source.scale, (tile.bounds.y - source.bounds.y) * source.scale, source.width, source.height]) },
        ] }));
        pass.dispatchWorkgroups(TILE_SIZE / 16, TILE_SIZE / 16);
      }
      pass.end();
      encoder.copyBufferToBuffer(reduction, 0, readback, 0, 16);
      frame.submit();
      await readback.mapAsync(GPUMapMode.READ);
      const [left, top, right, bottom] = new Uint32Array(readback.getMappedRange());
      readback.unmap();
      if (right <= left || bottom <= top) return null;
      return { x: source.bounds.x + left / source.scale, y: source.bounds.y + top / source.scale, width: (right - left) / source.scale, height: (bottom - top) / source.scale };
    } finally { frame.release(); reduction.destroy(); readback.destroy(); }
  }

  /** Integer crop/pad: copied texels stay bit-for-bit identical. New pixels are transparent. */
  resize(source: Surface, bounds: Rect): Surface {
    const output = createSurface('Reframed layer source', { x: 0, y: 0, width: bounds.width, height: bounds.height }, 1, source.format);
    const frame = this.gpu.beginFrame();
    try {
      for (const tile of source.tiles.values()) {
        const clipped = intersectBounds(tile.contentBounds, bounds);
        if (!clipped) continue;
        const shifted = { ...clipped, x: clipped.x - bounds.x, y: clipped.y - bounds.y };
        for (const region of planTiles(output, [shifted]).values()) {
          const destination = output.writable(frame, region.x, region.y, region.bounds, true);
          const x = Math.floor(region.bounds.x), y = Math.floor(region.bounds.y);
          const width = Math.ceil(region.bounds.x + region.bounds.width) - x, height = Math.ceil(region.bounds.y + region.bounds.height) - y;
          if (tile.resource.color) {
            paintSolid(frame, destination.resource, tile.resource.color, { x: x - destination.bounds.x, y: y - destination.bounds.y, width, height });
            continue;
          }
          frame.encoder.copyTextureToTexture(
            { texture: tile.texture, origin: [x + bounds.x - tile.bounds.x, y + bounds.y - tile.bounds.y] },
            { texture: destination.texture, origin: [x - destination.bounds.x, y - destination.bounds.y] }, [width, height],
          );
        }
      }
      frame.submit();
      return output;
    } catch (error) { output.destroy(); frame.release(); throw error; }
  }

  /** Bake the source's world placement into one texel per canonical canvas pixel. */
  normalize(source: Surface, canvas: Rect, world: Matrix): Surface {
    const output = createSurface('Normalized layer source', canvas, 1, source.format);
    const frame = this.gpu.beginFrame();
    try {
      const pass = this.quads.begin(frame, output);
      this.quads.draw(pass, frame, source, output, world);
      pass.end();
      frame.submit();
      return output;
    } catch (error) { output.destroy(); frame.release(); throw error; }
  }
}
