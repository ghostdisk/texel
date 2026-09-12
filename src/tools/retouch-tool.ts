import type { Editor } from '../editor';
import { GaussianBlur } from '../gpu/blur';
import { createSurface } from '../gpu/surface';
import type { Surface } from '../gpu/surface';
import type { RetouchInput } from '../gpu/retouch';
import { ImageLayer } from '../model/layers';
import { inverse, maxScale, multiply, transformPoint } from '../model/geometry';
import type { Matrix, Point } from '../model/geometry';
import { SliderInput } from '../ui/slider-input';
import { DrawingTool } from './drawing-tool';
import type { ToolPointer } from './tool';

interface RetouchStroke {
  input: RetouchInput;
  temporary: Surface[];
  offset: Point;
}

abstract class RetouchTool extends DrawingTool {
  abstract readonly heal: boolean;
  readonly cursor = 'crosshair';
  readonly hint = 'Alt-click a color image layer to sample · Paint on an editable color pixel layer';
  size = 48;
  hardness = 0.6;
  flow = 1;
  aligned = true;
  private sourceLayer: ImageLayer | null = null;
  private sourcePoint: Point = { x: 0, y: 0 };
  private sourceDocument = '';
  private alignedOffset: Point | null = null;
  private stroke: RetouchStroke | null = null;
  private last: Point = { x: 0, y: 0 };
  private status: HTMLElement | null = null;
  private blur: GaussianBlur | null = null;
  private hoverWorld: Point | null = null;

  constructor(editor: Editor) {
    super(editor);
  }

  pointerDown(pointer: ToolPointer): void {
    if (pointer.alt) { this.sample(pointer); return; }
    const source = this.validSource();
    const target = this.editor.paintTarget;
    if (!source || !target || target.channels !== 4 || !target.pixelEditable) { this.updateStatus(); return; }
    const sourceWorld = source.worldTransform();
    const targetWorld = target.worldTransform();
    const point = transformPoint(inverse(targetWorld), pointer.world);
    const sampledWorld = transformPoint(sourceWorld, this.sourcePoint);
    const offset = this.aligned && this.alignedOffset ? this.alignedOffset : {
      x: sampledWorld.x - pointer.world.x,
      y: sampledWorld.y - pointer.world.y,
    };
    const sourceTransform = multiply(inverse(sourceWorld), multiply([1, 0, 0, 1, offset.x, offset.y], targetWorld));
    const layer = this.beginDrawing();
    if (!layer) return;
    const temporary: Surface[] = [];
    try {
      const before = this.drawing!.snapshots.get(this.drawing!.before)!;
      const sourceSnapshot = source === layer ? before : this.snapshot(source.source, `${source.name}: retouch source`);
      if (source !== layer) temporary.push(sourceSnapshot);
      const [sourceBlur, destinationBlur] = this.heal ? this.prepareHealing(sourceSnapshot, before, temporary) : [null, null];
      this.stroke = {
        temporary,
        offset,
        input: {
          source: sourceSnapshot,
          sourceBlur,
          destinationBlur,
          sourceTransform,
          selection: this.drawing!.selection,
          heal: this.heal,
          erase: this.drawing!.erase,
        },
      };
      if (this.aligned && !this.alignedOffset) this.alignedOffset = offset;
      this.last = point;
      this.stamp(point, pointer.pressure);
    } catch (error) {
      try { super.cancel(); }
      finally { this.releaseStroke(temporary); }
      throw error;
    }
  }

  pointerMove(pointer: ToolPointer): void {
    if (!this.drawing || !this.stroke) return;
    const point = transformPoint(inverse(this.drawing.layer.worldTransform()), pointer.world);
    const spacing = Math.max(0.25, this.size * Math.max(0.05, pointer.pressure) * 0.1);
    let distance = Math.hypot(point.x - this.last.x, point.y - this.last.y);
    while (distance >= spacing) {
      const amount = spacing / distance;
      this.last = { x: this.last.x + (point.x - this.last.x) * amount, y: this.last.y + (point.y - this.last.y) * amount };
      this.stamp(this.last, pointer.pressure);
      distance = Math.hypot(point.x - this.last.x, point.y - this.last.y);
    }
  }

  private stamp(point: Point, pressure: number): void {
    if (!this.drawing || !this.stroke) return;
    this.editor.paintRetouch(this.drawing.layer, {
      x: point.x,
      y: point.y,
      radius: this.size * Math.max(0.05, pressure) / 2,
      hardness: this.hardness,
      flow: this.flow,
    }, this.stroke.input);
  }

  private sample(pointer: ToolPointer): void {
    const layer = this.editor.image.selected;
    if (!(layer instanceof ImageLayer) || layer.channels !== 4) { this.updateStatus('Select a color image or text layer to sample'); return; }
    const point = transformPoint(inverse(layer.worldTransform()), pointer.world);
    const bounds = layer.localBounds();
    if (point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height) {
      this.updateStatus('Alt-click inside the selected source layer');
      return;
    }
    this.sourceLayer = layer;
    this.sourcePoint = point;
    this.sourceDocument = this.editor.image.id;
    this.alignedOffset = null;
    this.updateStatus();
    this.editor.requestRender();
  }

  private validSource(): ImageLayer | null {
    if (this.sourceDocument !== this.editor.image.id || !this.sourceLayer || !this.editor.image.allLayers().includes(this.sourceLayer)) {
      this.sourceLayer = null;
      this.alignedOffset = null;
    }
    return this.sourceLayer;
  }

  private snapshot(source: Surface, label: string): Surface {
    const snapshot = createSurface(this.editor.gpu.device, label, source.bounds, source.scale, source.texture.format);
    try {
      const encoder = this.editor.gpu.device.createCommandEncoder({ label });
      encoder.copyTextureToTexture({ texture: source.texture }, { texture: snapshot.texture }, {
        width: source.texture.width,
        height: source.texture.height,
      });
      this.editor.gpu.device.queue.submit([encoder.finish()]);
      return snapshot;
    } catch (error) { snapshot.texture.destroy(); throw error; }
  }

  private prepareHealing(source: Surface, destination: Surface, temporary: Surface[]): [Surface, Surface] {
    const blur = this.blur ??= new GaussianBlur(this.editor.gpu);
    const makeBlur = (input: Surface, label: string) => {
      const scratch = createSurface(this.editor.gpu.device, label + ' scratch', input.bounds, input.scale);
      temporary.push(scratch);
      const output = createSurface(this.editor.gpu.device, label, input.bounds, input.scale);
      temporary.push(output);
      return { input, scratch, output };
    };
    const sourceBlur = makeBlur(source, 'Healing source blur');
    const destinationBlur = source === destination ? sourceBlur : makeBlur(destination, 'Healing destination blur');
    const frame = this.editor.gpu.beginFrame();
    try {
      const sigma = Math.max(1, Math.min(32, this.size / 8));
      blur.encode(frame, sourceBlur.input, sourceBlur.scratch, sourceBlur.output, sigma);
      if (destinationBlur !== sourceBlur) blur.encode(frame, destinationBlur.input, destinationBlur.scratch, destinationBlur.output, sigma);
      frame.submit();
      return [sourceBlur.output, destinationBlur.output];
    } catch (error) { frame.release(); throw error; }
  }

  finish(): void {
    const stroke = this.stroke;
    try { super.finish(); }
    finally { if (stroke) this.releaseStroke(stroke.temporary); }
  }

  cancel(): void {
    const stroke = this.stroke;
    try { super.cancel(); }
    finally { if (stroke) this.releaseStroke(stroke.temporary); }
  }

  private releaseStroke(temporary: Surface[]): void {
    this.stroke = null;
    for (const surface of temporary) surface.texture.destroy();
  }

  hover(pointer: ToolPointer | null): void {
    this.validSource();
    const cursor = this.editor.brushCursor;
    const target = this.editor.paintTarget;
    const previous = this.hoverWorld;
    this.hoverWorld = pointer && target?.channels === 4 && !this.editor.panHeld ? pointer.world : null;
    if (this.validSource() && (previous?.x !== this.hoverWorld?.x || previous?.y !== this.hoverWorld?.y)) this.editor.requestRender();
    cursor.hidden = !pointer || pointer.alt || !target || target.channels !== 4 || this.editor.panHeld;
    if (cursor.hidden || !pointer || !target) return;
    const diameter = this.size * maxScale(target.worldTransform()) * this.editor.viewport.scale;
    cursor.style.left = `${pointer.screen.x}px`;
    cursor.style.top = `${pointer.screen.y}px`;
    cursor.style.width = `${diameter}px`;
    cursor.style.height = `${diameter}px`;
  }

  drawOverlay(): void {
    const source = this.validSource();
    if (!source) return;
    const anchor = transformPoint(source.worldTransform(), this.sourcePoint);
    const offset = this.stroke?.offset ?? (this.aligned ? this.alignedOffset : null);
    const world = this.hoverWorld && offset ? { x: this.hoverWorld.x + offset.x, y: this.hoverWorld.y + offset.y } : anchor;
    const point = this.editor.viewport.worldToScreen(world);
    const circle = document.createElementNS(this.editor.overlay.namespaceURI, 'circle');
    circle.setAttribute('cx', String(point.x));
    circle.setAttribute('cy', String(point.y));
    circle.setAttribute('r', '7');
    circle.setAttribute('class', 'retouch-source');
    const horizontal = document.createElementNS(this.editor.overlay.namespaceURI, 'line');
    horizontal.setAttribute('x1', String(point.x - 11));
    horizontal.setAttribute('x2', String(point.x + 11));
    horizontal.setAttribute('y1', String(point.y));
    horizontal.setAttribute('y2', String(point.y));
    horizontal.setAttribute('class', 'retouch-source');
    const vertical = document.createElementNS(this.editor.overlay.namespaceURI, 'line');
    vertical.setAttribute('x1', String(point.x));
    vertical.setAttribute('x2', String(point.x));
    vertical.setAttribute('y1', String(point.y - 11));
    vertical.setAttribute('y2', String(point.y + 11));
    vertical.setAttribute('class', 'retouch-source');
    this.editor.overlay.append(circle, horizontal, vertical);
  }

  drawUI(container: HTMLElement): void {
    container.classList.add('retouch-options');
    const add = (label: string, key: 'size' | 'hardness' | 'flow', min: number, max: number, step: number, unit: string) => {
      const factor = key === 'size' ? 1 : 100;
      const control = new SliderInput({
        label, min, max, step, unit, get: () => this[key] * factor,
        input: (value) => { this[key] = value / factor; },
      });
      control.element.classList.add('brush-slider');
      container.append(control.element);
    };
    add('Size', 'size', 1, 400, 1, 'px');
    add('Hardness', 'hardness', 0, 100, 1, '%');
    add('Flow', 'flow', 1, 100, 1, '%');
    const aligned = document.createElement('label');
    aligned.className = 'tool-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.aligned;
    checkbox.onchange = () => { this.aligned = checkbox.checked; this.alignedOffset = null; };
    aligned.append(checkbox, 'Aligned');
    this.status = document.createElement('span');
    this.status.className = 'tool-status retouch-status';
    container.append(aligned, this.status);
    this.updateStatus();
  }

  syncUI(): void { this.updateStatus(); }

  private updateStatus(message?: string): void {
    const source = this.validSource();
    if (!this.status) return;
    this.status.textContent = message ?? (source ? `Source: ${source.name} · ${Math.round(this.sourcePoint.x)}, ${Math.round(this.sourcePoint.y)}` : 'Alt-click the selected color source layer');
  }
}

export class CloneStampTool extends RetouchTool {
  readonly id = 'clone-stamp';
  readonly label = 'Clone Stamp';
  readonly heal = false;
}

export class HealingBrushTool extends RetouchTool {
  readonly id = 'healing-brush';
  readonly label = 'Healing Brush';
  readonly heal = true;
}
