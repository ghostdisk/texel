import type { Gpu } from './device';
import type { Surface } from './surface';

/** Exact half-float transport for project files; no color conversion or premultiplication. */
export class PixelStorage {
  constructor(private readonly gpu: Gpu) {}

  async read(source: Surface, destination: Uint8Array): Promise<void> {
    const { device } = this.gpu;
    const width = source.texture.width, height = source.texture.height;
    const rowBytes = width * (source.texture.format === 'r16float' ? 2 : 8);
    if (destination.byteLength !== rowBytes * height) throw new Error('Pixel buffer length does not match its texture.');
    const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
    const bandHeight = Math.min(height, Math.max(1, Math.floor(Math.min(32 * 1024 * 1024, device.limits.maxBufferSize) / bytesPerRow)));
    const buffer = device.createBuffer({
      label: 'TXL pixel readback', size: bytesPerRow * bandHeight, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      for (let y = 0; y < height; y += bandHeight) {
        const rows = Math.min(bandHeight, height - y);
        const encoder = device.createCommandEncoder({ label: 'Save layer pixels' });
        encoder.copyTextureToBuffer({ texture: source.texture, origin: { x: 0, y, z: 0 } }, { buffer, bytesPerRow }, [width, rows]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        try {
          const mapped = new Uint8Array(buffer.getMappedRange());
          for (let row = 0; row < rows; row++) destination.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + rowBytes), (y + row) * rowBytes);
        } finally { buffer.unmap(); }
      }
    } finally { buffer.destroy(); }
  }

  write(destination: Surface, source: Uint8Array<ArrayBuffer>): void {
    const width = destination.texture.width, height = destination.texture.height;
    const bytesPerRow = width * (destination.texture.format === 'r16float' ? 2 : 8);
    if (source.byteLength !== bytesPerRow * height) throw new Error('Pixel buffer length does not match its texture.');
    const bandHeight = Math.max(1, Math.floor(32 * 1024 * 1024 / bytesPerRow));
    for (let y = 0; y < height; y += bandHeight) {
      const rows = Math.min(bandHeight, height - y);
      this.gpu.device.queue.writeTexture(
        { texture: destination.texture, origin: { x: 0, y, z: 0 } },
        source.subarray(y * bytesPerRow, (y + rows) * bytesPerRow), { bytesPerRow }, [width, rows],
      );
    }
  }
}