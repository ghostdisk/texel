import type { Gpu } from './device';
import { TILE_SIZE, intersectBounds, planTiles, tileBytes, floatToHalf, halfToFloat } from './surface';
import type { Surface, Tile, TileColor } from './surface';

export interface StoredTile {
  x: number;
  y: number;
  /** Solid records have no BIN payload. Missing records remain zero. */
  color?: TileColor;
}

interface ResidentEntry {
  tile: Tile;
  index: number;
}

/** Exact half-float transport; solid records stay metadata and GPU staging remains bounded. */
export class PixelStorage {
  constructor(private readonly gpu: Gpu) {}

  async read(source: Surface, destination: Uint8Array, records?: readonly StoredTile[]): Promise<void> {
    const channels = source.format === 'r16float' ? 1 : 4;
    const pixelBytes = channels * 2, bytes = tileBytes(source.format);
    const stored = records?.filter((tile) => !tile.color);
    const expected = stored ? stored.length * bytes : source.width * source.height * pixelBytes;
    if (destination.byteLength !== expected) throw new Error('Pixel buffer length does not match the image.');
    destination.fill(0);
    const tiles = (stored ? stored.map(({ x, y }) => source.tile(x, y)) : [...source.tiles.values()]).map((tile, index) => ({ tile, index }));
    const resident = tiles.filter((entry): entry is ResidentEntry => !!entry.tile && entry.tile.resource.color === null);
    for (const { tile, index } of tiles) {
      if (!tile?.resource.color) continue;
      const data = this.solidData(source, tile);
      if (stored) destination.set(data, index * bytes);
      else this.copyRows(source, tile, data, destination, pixelBytes);
    }
    if (!resident.length) return;
    const capacity = Math.min(resident.length, Math.max(1, Math.floor(Math.min(16 * 1024 * 1024, this.gpu.device.limits.maxBufferSize) / bytes)));
    const buffer = this.gpu.device.createBuffer({ label: 'Tile pixel readback', size: capacity * bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      for (let start = 0; start < resident.length; start += capacity) {
        const batch = resident.slice(start, start + capacity), encoder = this.gpu.device.createCommandEncoder({ label: 'Read image tiles' });
        batch.forEach(({ tile }, index) => encoder.copyTextureToBuffer({ texture: tile.texture },
          { buffer, offset: index * bytes, bytesPerRow: TILE_SIZE * pixelBytes }, [TILE_SIZE, TILE_SIZE]));
        this.gpu.device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        try {
          const mapped = new Uint8Array(buffer.getMappedRange());
          batch.forEach(({ tile, index }, slot) => {
            const data = mapped.subarray(slot * bytes, (slot + 1) * bytes);
            if (stored) destination.set(data, index * bytes);
            else this.copyRows(source, tile, data, destination, pixelBytes);
          });
        } finally { buffer.unmap(); }
      }
    } finally { buffer.destroy(); }
  }

  private solidData(source: Surface, tile: Tile): Uint8Array<ArrayBuffer> {
    const channels = source.format === 'r16float' ? 1 : 4, data = new Uint16Array(TILE_SIZE * TILE_SIZE * channels);
    const color = tile.resource.color!, pixel = Uint16Array.from(channels === 1 ? [color[0]] : color, floatToHalf);
    const clip = intersectBounds(source.bounds, tile.bounds)!;
    const x = Math.round((clip.x - tile.bounds.x) * source.scale), y = Math.round((clip.y - tile.bounds.y) * source.scale);
    const width = Math.round(clip.width * source.scale), height = Math.round(clip.height * source.scale);
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) data.set(pixel, (row * TILE_SIZE + column) * channels);
    return new Uint8Array(data.buffer);
  }

  private copyRows(source: Surface, tile: Tile, data: Uint8Array, destination: Uint8Array, pixelBytes: number): void {
    const clip = intersectBounds(tile.bounds, source.bounds);
    if (!clip) return;
    const x = Math.round((clip.x - source.bounds.x) * source.scale), y = Math.round((clip.y - source.bounds.y) * source.scale);
    const tx = Math.round((clip.x - tile.bounds.x) * source.scale), ty = Math.round((clip.y - tile.bounds.y) * source.scale);
    const width = Math.round(clip.width * source.scale), height = Math.round(clip.height * source.scale);
    for (let row = 0; row < height; row++) {
      const offset = ((ty + row) * TILE_SIZE + tx) * pixelBytes;
      destination.set(data.subarray(offset, offset + width * pixelBytes), ((y + row) * source.width + x) * pixelBytes);
    }
  }

  write(destination: Surface, source: Uint8Array<ArrayBuffer>, records?: readonly StoredTile[]): void {
    const channels = destination.format === 'r16float' ? 1 : 4, pixelBytes = channels * 2, bytes = tileBytes(destination.format);
    const expected = records ? records.filter((tile) => !tile.color).length * bytes : destination.width * destination.height * pixelBytes;
    if (source.byteLength !== expected) throw new Error('Pixel buffer length does not match the image.');
    const frame = this.gpu.beginFrame();
    try {
      const planned: readonly StoredTile[] = records ?? [...planTiles(destination, [destination.bounds]).values()];
      destination.retain(new Set(), frame);
      let offset = 0;
      for (const record of planned) {
        const { x, y } = record, bounds = destination.tileBounds(x, y);
        if (record.color) { destination.setColor(frame, x, y, record.color); continue; }
        const clip = intersectBounds(bounds, destination.bounds)!;
        const tx = Math.round((clip.x - bounds.x) * destination.scale), ty = Math.round((clip.y - bounds.y) * destination.scale);
        const width = Math.round(clip.width * destination.scale), height = Math.round(clip.height * destination.scale);
        const data = new Uint8Array(bytes);
        if (records) {
          // Ignore padding outside the logical image, including untrusted file padding.
          for (let row = ty; row < ty + height; row++) {
            const start = (row * TILE_SIZE + tx) * pixelBytes;
            data.set(source.subarray(offset + start, offset + start + width * pixelBytes), start);
          }
          offset += bytes;
        } else {
          const sx = Math.round((clip.x - destination.bounds.x) * destination.scale), sy = Math.round((clip.y - destination.bounds.y) * destination.scale);
          for (let row = 0; row < height; row++) {
            const start = ((sy + row) * destination.width + sx) * pixelBytes;
            data.set(source.subarray(start, start + width * pixelBytes), ((ty + row) * TILE_SIZE + tx) * pixelBytes);
          }
        }
        let left = TILE_SIZE, top = TILE_SIZE, right = 0, bottom = 0, uniform = true;
        const first = (ty * TILE_SIZE + tx) * pixelBytes;
        for (let py = ty; py < ty + height; py++) for (let px = tx; px < tx + width; px++) {
          let occupied = false;
          const index = (py * TILE_SIZE + px) * pixelBytes;
          for (let byte = 0; byte < pixelBytes; byte++) {
            occupied ||= data[index + byte] !== 0;
            uniform &&= data[index + byte] === data[first + byte];
          }
          if (!occupied) continue;
          left = Math.min(left, px); top = Math.min(top, py); right = Math.max(right, px + 1); bottom = Math.max(bottom, py + 1);
        }
        if (right <= left) continue;
        if (uniform) {
          const values = [...new Uint16Array(data.buffer, first, channels)].map(halfToFloat);
          // Preserve NaNs and signed zero byte-for-byte in resident storage.
          if (values.every((value) => Number.isFinite(value) && !Object.is(value, -0))) {
            destination.setColor(frame, x, y, channels === 1 ? [values[0], 0, 0, 1] : [values[0], values[1], values[2], values[3]]);
            continue;
          }
        }
        const content = { x: bounds.x + left / destination.scale, y: bounds.y + top / destination.scale,
          width: (right - left) / destination.scale, height: (bottom - top) / destination.scale };
        const tile = destination.writable(frame, x, y, content, false, false);
        this.gpu.device.queue.writeTexture({ texture: tile.texture }, data, { bytesPerRow: TILE_SIZE * pixelBytes }, [TILE_SIZE, TILE_SIZE]);
      }
      frame.submit();
    } catch (error) { frame.release(); throw error; }
  }
}
