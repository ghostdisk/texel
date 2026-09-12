import type { Surface } from '../gpu/surface';
import type { Gpu } from '../gpu/device';
import type { JsonObject, UndoDirection, UndoOperation } from '../history/undo';
import { ImageLayer } from './layers';
import type { LayerProperties, LayerUndoContext } from './layers';

export interface TextProperties extends JsonObject {
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  color: string;
}

export const DEFAULT_TEXT: TextProperties = {
  text: 'Text', fontFamily: 'Arial', fontSize: 48, bold: false, italic: false, align: 'left', lineHeight: 1.2, color: '#ffffff',
};

export function validateText(value: unknown): TextProperties {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid text layer settings.');
  const data = value as Record<string, unknown>;
  if (typeof data.text !== 'string' || data.text.length > 65536 ||
    typeof data.fontFamily !== 'string' || !data.fontFamily.trim() || data.fontFamily.length > 128 || /[\x00-\x1f"\\]/.test(data.fontFamily) ||
    typeof data.fontSize !== 'number' || !Number.isFinite(data.fontSize) || data.fontSize < 1 || data.fontSize > 2048 ||
    typeof data.lineHeight !== 'number' || !Number.isFinite(data.lineHeight) || data.lineHeight < 0.5 || data.lineHeight > 4 ||
    typeof data.bold !== 'boolean' || typeof data.italic !== 'boolean' ||
    !['left', 'center', 'right'].includes(String(data.align)) || typeof data.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(data.color)) {
    throw new Error('Invalid text content, font, size, alignment, spacing, or color.');
  }
  return {
    text: data.text.replace(/\r\n?/g, '\n'), fontFamily: data.fontFamily.trim(), fontSize: data.fontSize,
    bold: data.bold, italic: data.italic, align: data.align as TextProperties['align'], lineHeight: data.lineHeight, color: data.color,
  };
}

/** Editable typography with a cached GPU image. Position is the ordinary layer transform. */
export class TextLayer extends ImageLayer {
  override readonly kind = 'text';
  private content: TextProperties;

  constructor(name: string, source: Surface, properties: TextProperties, id?: string) {
    super(name, source, id);
    this.content = validateText(properties);
  }

  override get pixelEditable(): boolean { return false; }
  get textProperties(): TextProperties { return { ...this.content }; }

  updateText(properties: TextProperties, source: Surface): void {
    const content = validateText(properties);
    this.replaceSource(source);
    this.content = content;
  }

  restoreText(gpu: Gpu, properties: TextProperties, snapshot: Surface): void {
    const content = validateText(properties);
    this.restorePixels(gpu, snapshot);
    this.content = content;
  }

  override setProperties(properties: LayerProperties): void {
    if (properties.selection) throw new Error('A text layer cannot be a selection mask.');
    super.setProperties(properties);
  }

  override applyUndo(operation: UndoOperation, direction: UndoDirection, context?: LayerUndoContext): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'layer' || payload.targetId !== this.id || payload.action !== 'text') {
      super.applyUndo(operation, direction, context);
      return;
    }
    if (!context) throw new Error('GPU context is required to restore text.');
    this.restoreText(context.gpu, validateText(payload.data.text), operation.snapshot(String(payload.data.snapshotId)));
  }
}
