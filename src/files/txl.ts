import type { Gpu } from '../gpu/device';
import type { Compositor } from '../gpu/compositor';
import { PixelStorage } from '../gpu/pixel-storage';
import { createSurface } from '../gpu/surface';
import type { Surface } from '../gpu/surface';
import type { FilterRegistry, SerializedFilter } from '../filters/filter';
import type { JsonObject } from '../history/undo';
import type { ImageDocument } from '../model/image-document';
import { GroupLayer, ImageLayer, Layer, isBlendMode, validateLayerDependencies } from '../model/layers';
import type { LayerProperties } from '../model/layers';
import { inverse } from '../model/geometry';
import type { Matrix } from '../model/geometry';
import { TextLayer, validateText } from '../model/text-layer';
import type { TextProperties } from '../model/text-layer';
import { DEFAULT_GRID_SIZE, MAX_GUIDES, validatePrecision } from '../model/precision';
import type { Guide, PrecisionState } from '../model/precision';

const MAGIC = 0x004c5854; // "TXL\0"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
export const TXL_VERSION = 1;
const MAX_FILE_BYTES = 0x7fffffff;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const align4 = (value: number) => Math.ceil(value / 4) * 4;

interface TxlBuffer {
  byteOffset: number;
  byteLength: number;
  width: number;
  height: number;
  format: 'rgba16float' | 'r16float';
}
interface TxlLayer {
  id: string;
  kind: 'image' | 'group' | 'text';
  properties: LayerProperties;
  filters: SerializedFilter[];
  buffer: number | null;
  children: TxlLayer[];
  text: TextProperties | null;
}
interface TxlDocument {
  width: number;
  height: number;
  root: TxlLayer;
  selectedLayerIds: string[];
  activeLayerId: string;
  activeSelectionId: string | null;
  generationLens: number[];
  gridSize: number;
  guides: Guide[];
}
interface TxlManifest {
  format: 'texel';
  schemaVersion: number;
  document: TxlDocument;
  buffers: TxlBuffer[];
}
export interface LoadedDocument {
  root: GroupLayer;
  width: number;
  height: number;
  selection: JsonObject;
  activeSelectionId: string | null;
  generationLens: Matrix;
  precision: PrecisionState;
}

/** Version 1: a GLB-style header followed by JSON and raw half-float BIN chunks. */
export class TxlFormat {
  private readonly pixels: PixelStorage;

  constructor(private readonly gpu: Gpu, private readonly compositor: Compositor, private readonly filters: FilterRegistry) {
    this.pixels = new PixelStorage(gpu);
  }

  async encode(image: ImageDocument, lens: Matrix): Promise<Uint8Array<ArrayBuffer>> {
    this.compositor.flush();
    const sources: Surface[] = [];
    const buffers: TxlBuffer[] = [];
    let binaryLength = 0;
    const serialize = (layer: Layer): TxlLayer => {
      let buffer: number | null = null;
      if (layer instanceof ImageLayer) {
        const source = layer.source;
        const format = source.texture.format;
        if (format !== 'rgba16float' && format !== 'r16float') throw new Error('Unsupported source pixel format: ' + format);
        if (source.scale !== 1 || source.bounds.x !== 0 || source.bounds.y !== 0) throw new Error('Layer source must use native pixel coordinates.');
        const byteLength = layer.width * layer.height * (format === 'r16float' ? 2 : 8);
        buffer = buffers.length;
        buffers.push({ byteOffset: binaryLength, byteLength, width: layer.width, height: layer.height, format });
        sources.push(source);
        binaryLength = align4(binaryLength + byteLength);
      } else if (!(layer instanceof GroupLayer)) throw new Error('Unsupported layer type: ' + layer.kind);
      return {
        id: layer.id, kind: layer instanceof TextLayer ? 'text' : layer instanceof ImageLayer ? 'image' : 'group', properties: layer.properties(),
        filters: layer.filters.map((filter) => filter.serialize()), buffer,
        children: layer instanceof GroupLayer ? layer.children.map(serialize) : [],
        text: layer instanceof TextLayer ? layer.textProperties : null,
      };
    };
    const manifest: TxlManifest = {
      format: 'texel', schemaVersion: 2,
      document: {
        width: image.width, height: image.height, root: serialize(image.root),
        selectedLayerIds: image.selectedLayers.map((layer) => layer.id), activeLayerId: image.selected.id,
        activeSelectionId: image.selectionMask?.id ?? null, generationLens: [...lens],
        gridSize: image.gridSize, guides: image.guides.map((guide) => ({ ...guide })),
      },
      buffers,
    };
    const json = new TextEncoder().encode(JSON.stringify(manifest));
    const jsonLength = align4(json.byteLength);
    const total = 28 + jsonLength + binaryLength;
    if (jsonLength > MAX_JSON_BYTES || total > MAX_FILE_BYTES) throw new Error('This document exceeds the TXL v1 implementation size limit (2 GiB).');
    // Validate before saving too, so a document cannot be written in a form this version cannot reopen.
    this.validate(manifest, binaryLength);
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, TXL_VERSION, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, JSON_CHUNK, true);
    bytes.fill(0x20, 20, 20 + jsonLength);
    bytes.set(json, 20);
    const binaryHeader = 20 + jsonLength;
    view.setUint32(binaryHeader, binaryLength, true);
    view.setUint32(binaryHeader + 4, BIN_CHUNK, true);
    const binaryStart = binaryHeader + 8;
    for (let index = 0; index < sources.length; index++) {
      const buffer = buffers[index];
      await this.pixels.read(sources[index], bytes.subarray(binaryStart + buffer.byteOffset, binaryStart + buffer.byteOffset + buffer.byteLength));
    }
    return bytes;
  }

  async decode(bytes: Uint8Array<ArrayBuffer>): Promise<LoadedDocument> {
    const { manifest, binary } = this.parse(bytes);
    const created: Layer[] = [];
    let root: Layer | null = null;
    let failure: unknown;
    this.gpu.device.pushErrorScope('out-of-memory');
    this.gpu.device.pushErrorScope('validation');
    try {
      const restore = (data: TxlLayer): Layer => {
        let layer: Layer;
        if (data.kind === 'image' || data.kind === 'text') {
          const buffer = manifest.buffers[data.buffer!];
          const surface = createSurface(this.gpu.device, data.properties.name + ': source', { x: 0, y: 0, width: buffer.width, height: buffer.height }, 1, buffer.format);
          layer = data.kind === 'text' ? new TextLayer(data.properties.name, surface, data.text!, data.id) : new ImageLayer(data.properties.name, surface, data.id);
          created.push(layer);
          this.pixels.write(surface, binary.subarray(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
        } else {
          layer = new GroupLayer(data.properties.name, data.id);
          created.push(layer);
        }
        layer.setProperties(data.properties);
        for (const filter of data.filters) layer.addFilter(this.filters.deserialize(filter));
        if (layer instanceof GroupLayer) for (const child of data.children) layer.add(restore(child));
        return layer;
      };
      root = restore(manifest.document.root);
      validateLayerDependencies(root);
    } catch (error) { failure = error; }
    try {
      const [validation, memory] = await Promise.all([this.gpu.device.popErrorScope(), this.gpu.device.popErrorScope()]);
      failure ??= validation ? new Error('Cannot load document pixels: ' + validation.message) : memory ? new Error('Not enough GPU memory to open this document.') : undefined;
    } catch (error) { failure ??= error; }
    if (failure || !(root instanceof GroupLayer)) {
      for (const layer of created.filter((layer) => !layer.parent)) this.compositor.release(layer);
      throw failure ?? new Error('The TXL root must be a group.');
    }
    const document = manifest.document;
    return {
      root, width: document.width, height: document.height,
      selection: { ids: document.selectedLayerIds, active: document.activeLayerId },
      activeSelectionId: document.activeSelectionId, generationLens: document.generationLens as unknown as Matrix,
      precision: { gridSize: document.gridSize, guides: document.guides },
    };
  }

  private parse(bytes: Uint8Array<ArrayBuffer>): {
    manifest: TxlManifest;
    binary: Uint8Array<ArrayBuffer>;
  } {
    const invalid = () => new Error('Invalid or truncated TXL document.');
    if (bytes.byteLength < 28 || bytes.byteLength > MAX_FILE_BYTES) throw invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== MAGIC) throw new Error('This is not a Texel (.txl) document.');
    const version = view.getUint32(4, true);
    if (version !== TXL_VERSION) throw new Error('Unsupported TXL version ' + version + '. This Texel build supports version ' + TXL_VERSION + '.');
    if (view.getUint32(8, true) !== bytes.byteLength) throw invalid();
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== JSON_CHUNK || jsonLength % 4 || jsonLength > MAX_JSON_BYTES || 28 + jsonLength > bytes.byteLength) throw invalid();
    const binaryHeader = 20 + jsonLength;
    const binaryLength = view.getUint32(binaryHeader, true);
    if (view.getUint32(binaryHeader + 4, true) !== BIN_CHUNK || binaryLength % 4 || binaryHeader + 8 + binaryLength !== bytes.byteLength) throw invalid();
    let json: unknown;
    try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, binaryHeader))); }
    catch { throw new Error('The TXL JSON metadata is invalid.'); }
    return { manifest: this.validate(json, binaryLength), binary: bytes.subarray(binaryHeader + 8) };
  }

  private validate(value: unknown, binaryLength: number): TxlManifest {
    const bad = (message: string): never => { throw new Error('Invalid TXL document: ' + message); };
    const object = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('expected an object.');
      return value as Record<string, unknown>;
    };
    const integer = (value: unknown, min: number, max: number): number => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return bad('invalid integer or dimensions.');
      return value;
    };
    const text = (value: unknown, limit = 256): string => {
      if (typeof value !== 'string' || !value.length || value.length > limit) return bad('invalid name or ID.');
      return value;
    };
    const array = (value: unknown, limit = 10000): unknown[] => {
      if (!Array.isArray(value) || value.length > limit) return bad('invalid or oversized array.');
      return value;
    };
    const matrix = (value: unknown): number[] => {
      const values = array(value, 6);
      if (values.length !== 6 || !values.every((item) => typeof item === 'number' && Number.isFinite(item))) return bad('invalid transform.');
      try { inverse(values as unknown as Matrix); } catch { return bad('non-invertible transform.'); }
      return values as number[];
    };
    const manifest = object(value);
    if (manifest.format !== 'texel') return bad('unrecognized document format.');
    if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) throw new Error('Unsupported Texel document schema version ' + String(manifest.schemaVersion) + '.');
    const limit = this.gpu.device.limits.maxTextureDimension2D;
    const buffers = array(manifest.buffers).map((value): TxlBuffer => {
      const data = object(value);
      const width = integer(data.width, 1, limit), height = integer(data.height, 1, limit);
      const format = data.format;
      if (format !== 'rgba16float' && format !== 'r16float') return bad('unsupported pixel encoding.');
      const byteOffset = integer(data.byteOffset, 0, binaryLength);
      const byteLength = integer(data.byteLength, 1, binaryLength);
      if (byteOffset % 4 || byteLength !== width * height * (format === 'r16float' ? 2 : 8) || byteOffset + byteLength > binaryLength) return bad('pixel buffer exceeds its binary chunk.');
      return { width, height, format, byteOffset, byteLength };
    });
    let end = 0;
    for (const buffer of [...buffers].sort((a, b) => a.byteOffset - b.byteOffset)) {
      if (buffer.byteOffset < end) return bad('overlapping pixel buffers.');
      end = buffer.byteOffset + buffer.byteLength;
    }
    const ids = new Set<string>(), filterIds = new Set<string>();
    let selectionId: string | null = null;
    let layerCount = 0, filterCount = 0, pixelBytes = 0;
    const layer = (value: unknown, depth: number): TxlLayer => {
      if (++layerCount > 10000 || depth > 128) return bad('layer tree is too large or deeply nested.');
      const data = object(value);
      const id = text(data.id);
      if (ids.has(id)) return bad('duplicate layer ID.');
      ids.add(id);
      if (data.kind !== 'image' && data.kind !== 'group' && !(manifest.schemaVersion === 2 && data.kind === 'text')) return bad('unsupported layer type.');
      const props = object(data.properties);
      const name = text(props.name, 4096), transform = matrix(props.transform);
      if (typeof props.opacity !== 'number' || !Number.isFinite(props.opacity) || props.opacity < 0 || props.opacity > 1) return bad('invalid opacity.');
      if (typeof props.visible !== 'boolean' || typeof props.selection !== 'boolean') return bad('invalid layer flags.');
      if (!isBlendMode(props.blendMode)) return bad('unsupported blend mode.');
      const properties: LayerProperties = { name, transform, opacity: props.opacity, visible: props.visible, selection: props.selection, blendMode: props.blendMode };
      const filters = array(data.filters).map((value) => {
        if (++filterCount > 10000) return bad('too many filters.');
        const serialized = object(value);
        const filterId = text(serialized.id);
        if (filterIds.has(filterId)) return bad('duplicate filter ID.');
        filterIds.add(filterId);
        text(serialized.kind);
        object(serialized.properties);
        if (typeof serialized.enabled !== 'boolean' || typeof serialized.mix !== 'number' || !Number.isFinite(serialized.mix) || serialized.mix < 0 || serialized.mix > 1) return bad('invalid filter flags or Mix.');
        // Each registered filter validates its own property schema; unknown kinds fail explicitly.
        return this.filters.deserialize(serialized as unknown as SerializedFilter).serialize();
      });
      let buffer: number | null = null;
      if (data.kind === 'image' || data.kind === 'text') {
        buffer = integer(data.buffer, 0, buffers.length - 1);
        pixelBytes += buffers[buffer].byteLength;
        if (pixelBytes > MAX_FILE_BYTES) return bad('decoded pixels exceed the 2 GiB limit.');
      } else if (data.buffer !== null) return bad('groups cannot own source pixels.');
      if (props.selection) {
        if (selectionId || buffer === null || buffers[buffer].format !== 'r16float') return bad('a document can have one single-channel selection layer.');
        selectionId = id;
      }
      const children = array(data.children);
      if (data.kind !== 'group' && children.length) return bad('image and text layers cannot contain children.');
      const content = data.kind === 'text' ? validateText(data.text) : null;
      if (content && (props.selection || buffer === null || buffers[buffer].format !== 'rgba16float')) return bad('text requires an RGBA image and cannot be a selection.');
      return { id, kind: data.kind as TxlLayer['kind'], properties, filters, buffer, children: children.map((child) => layer(child, depth + 1)), text: content };
    };
    const doc = object(manifest.document);
    const width = integer(doc.width, 1, limit), height = integer(doc.height, 1, limit);
    const guideValues = doc.guides === undefined ? [] : array(doc.guides, MAX_GUIDES);
    if (doc.gridSize !== undefined && typeof doc.gridSize !== 'number') return bad('invalid grid spacing.');
    const precision = validatePrecision({
      gridSize: doc.gridSize === undefined ? DEFAULT_GRID_SIZE : doc.gridSize,
      guides: guideValues.map((value) => {
        const guide = object(value);
        if (typeof guide.position !== 'number') return bad('invalid guide position.');
        return { axis: guide.axis as Guide['axis'], position: guide.position };
      }),
    });
    const root = layer(doc.root, 0);
    if (root.kind !== 'group') return bad('the document root must be a group.');
    const selectedLayerIds = array(doc.selectedLayerIds).map((id) => text(id));
    const activeLayerId = text(doc.activeLayerId);
    if (!selectedLayerIds.length || new Set(selectedLayerIds).size !== selectedLayerIds.length ||
      !selectedLayerIds.every((id) => ids.has(id)) || !selectedLayerIds.includes(activeLayerId)) return bad('invalid layer selection.');
    if (selectedLayerIds.length > 1 && selectedLayerIds.some((id) => id === root.id || id === selectionId)) return bad('the root or selection mask cannot be part of a multiple layer selection.');
    if (doc.activeSelectionId !== null && doc.activeSelectionId !== selectionId) return bad('invalid active selection mask.');
    if (doc.activeSelectionId === null && selectionId && selectedLayerIds.includes(selectionId)) return bad('an inactive selection mask cannot be the selected layer.');
    return {
      format: 'texel', schemaVersion: manifest.schemaVersion, buffers,
      document: {
        width, height, root, selectedLayerIds, activeLayerId, activeSelectionId: doc.activeSelectionId as string | null,
        generationLens: matrix(doc.generationLens), gridSize: precision.gridSize, guides: precision.guides,
      },
    };
  }
}
