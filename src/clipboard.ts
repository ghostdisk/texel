import type { Editor } from './editor';
import { rgbaToPng } from './generation/image-codec';
import { createSurface } from './gpu/surface';
import type { Surface } from './gpu/surface';
import { importImage } from './gpu/images';
import type { SerializedLayer } from './model/image-document';
import { ImageLayer } from './model/layers';
import { inverse, multiply } from './model/geometry';
import type { Matrix } from './model/geometry';

interface LayerClipboardPayload {
  id: string;
  layers: SerializedLayer[];
  snapshots: Map<string, Surface>;
  transforms: Matrix[];
}

interface ClipboardMetadata {
  version: number;
  type: 'layers' | 'pixels';
  id?: string;
  transform?: number[];
}

export class EditorClipboard {
  private layers: LayerClipboardPayload | null = null;

  constructor(private readonly editor: Editor) {}

  dispose(): void { this.releaseLayers(); }

  get canCopy(): boolean {
    return this.editor.image.selectionMask ? !!this.editor.selectionPixelTarget : this.editor.image.selectedRoots.length > 0;
  }

  get canCut(): boolean {
    const target = this.editor.selectionPixelTarget;
    return this.editor.image.selectionMask ? !!target?.pixelEditable : this.editor.image.selectedRoots.length > 0;
  }

  async copy(): Promise<void> {
    if (this.editor.image.selectionMask) await this.copyPixels();
    else await this.copyLayers();
  }

  async cut(): Promise<void> {
    if (this.editor.image.selectionMask) {
      const target = this.editor.selectionPixelTarget;
      if (!target?.pixelEditable) return;
      await this.copyPixels();
      this.editor.clearSelectedPixels(target);
    } else {
      if (!this.editor.image.selectedRoots.length) return;
      await this.copyLayers();
      this.editor.image.deleteSelected();
    }
  }

  async paste(): Promise<void> {
    const content = await window.desktop.readClipboard();
    if (!content) return;
    const metadata = this.metadata(content.metadata);
    if (metadata?.type === 'layers' && metadata.id && this.layers?.id === metadata.id) {
      this.editor.image.commands.paste(this.layers.layers, this.layers.snapshots, this.layers.transforms);
      return;
    }
    if (!content.image?.byteLength) return;
    const parent = this.editor.image.destination();
    const layer = await importImage(this.editor.gpu, this.editor.compositor.quads, 'Pasted pixels',
      new Blob([content.image], { type: content.mediaType || 'image/png' }));
    try {
      const transform = metadata?.type === 'pixels' ? this.matrix(metadata.transform) : null;
      if (transform) layer.setTransform(multiply(inverse(parent.worldTransform()), transform));
      else layer.setTransform(multiply(inverse(parent.worldTransform()), [1, 0, 0, 1,
        (this.editor.image.width - layer.width) / 2, (this.editor.image.height - layer.height) / 2]));
      this.editor.image.add(layer, parent);
    } catch (error) { if (!layer.parent) this.editor.compositor.release(layer); throw error; }
  }

  private async copyLayers(): Promise<void> {
    const selected = this.editor.image.selectedRoots;
    if (!selected.length) return;
    const snapshots = new Map<string, Surface>();
    let layers: SerializedLayer[];
    try { layers = selected.map((layer) => this.editor.image.serializeLayer(layer, snapshots)); }
    catch (error) { for (const surface of snapshots.values()) surface.texture.destroy(); throw error; }
    const payload: LayerClipboardPayload = {
      id: crypto.randomUUID(), layers, snapshots, transforms: selected.map((layer) => [...layer.worldTransform()] as Matrix),
    };
    try {
      const written = await window.desktop.writeClipboard({
        metadata: JSON.stringify({ version: 1, type: 'layers', id: payload.id }), image: null,
      });
      if (!written) throw new Error('The system clipboard rejected the layer data.');
    } catch (error) { for (const surface of snapshots.values()) surface.texture.destroy(); throw error; }
    this.releaseLayers();
    this.layers = payload;
  }

  private async copyPixels(): Promise<void> {
    const layer = this.editor.selectionPixelTarget;
    const selection = this.editor.image.selectionMask;
    if (!layer || !selection) return;
    const extracted = await this.extract(layer);
    try {
      const rgba = await this.editor.readback.rgba(extracted.surface, false, true);
      const png = await rgbaToPng(rgba, extracted.surface.texture.width, extracted.surface.texture.height);
      const image = new Uint8Array(await png.arrayBuffer());
      const written = await window.desktop.writeClipboard({
        metadata: JSON.stringify({ version: 1, type: 'pixels', transform: extracted.transform }), image,
      });
      if (!written) throw new Error('The system clipboard rejected the selected pixels.');
      this.releaseLayers();
    } finally { extracted.surface.texture.destroy(); }
  }

  private async extract(layer: ImageLayer): Promise<{ surface: Surface; transform: Matrix }> {
    const selection = this.editor.captureSelection(layer);
    if (!selection) throw new Error('There is no active selection to copy.');
    const masked = createSurface(this.editor.gpu.device, 'Clipboard selection', layer.source.bounds);
    const frame = this.editor.gpu.beginFrame();
    try {
      this.editor.layerMasks.encode(frame, layer.source, masked, selection);
      frame.submit();
      const bounds = await this.editor.layerReframer.contentBounds(masked);
      if (!bounds) throw new Error('There are no pixels in the selected area.');
      const surface = this.editor.layerReframer.resize(masked, bounds);
      return { surface, transform: multiply(layer.worldTransform(), [1, 0, 0, 1, bounds.x, bounds.y]) };
    } finally {
      frame.release();
      selection.surface.texture.destroy();
      masked.texture.destroy();
    }
  }

  private metadata(value: string): ClipboardMetadata | null {
    try {
      const parsed = JSON.parse(value);
      if (parsed?.version !== 1 || parsed.type !== 'layers' && parsed.type !== 'pixels') return null;
      return parsed as ClipboardMetadata;
    } catch { return null; }
  }

  private matrix(value: unknown): Matrix | null {
    return Array.isArray(value) && value.length === 6 && value.every((item) => Number.isFinite(item)) ? value as Matrix : null;
  }

  private releaseLayers(): void {
    if (!this.layers) return;
    for (const surface of this.layers.snapshots.values()) surface.texture.destroy();
    this.layers = null;
  }
}
