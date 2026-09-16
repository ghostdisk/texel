import type { Editor } from '../editor';
import { inverse, multiply, transformPoint } from '../model/geometry';
import type { Point } from '../model/geometry';
import type { GenerationFrame, GenerationLens } from '../generation/lens';
import type { GenerationExpansion, GenerationExpandConstraints } from '../generation/provider';
import type { AIRequestService } from '../generation/service';
import type { ToolPointer } from '../tools/tool';
import { Generator } from './generator';

const HANDLES: readonly Point[] = [
  { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 },
  { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 },
];

interface ExpansionGesture {
  before: GenerationExpansion;
  frame: GenerationFrame;
  start: Point;
  handle: Point;
}

function ratio(value: string): number {
  const [width, height] = value.split(':').map(Number);
  return width / height;
}

export class ExpandGenerator extends Generator {
  readonly id = 'expand';
  readonly label = 'Outpaint / Expand';
  readonly resultName = 'Expanded image';
  readonly modelTypes = ['expand-reframe'] as const;
  margins: GenerationExpansion = { left: 100, right: 100, top: 100, bottom: 100 };
  private gesture: ExpansionGesture | null = null;
  private promptField: HTMLElement | null = null;
  private readonly marginFields = new Map<keyof GenerationExpansion, HTMLInputElement>();

  constructor(editor: Editor, service: AIRequestService, lens: GenerationLens) { super(editor, service, lens); }

  protected override get requiresPrompt(): boolean { return false; }
  override get previewKey(): unknown { return this.margins; }

  override get frame(): GenerationFrame {
    const constraints = this.selectedModel?.capabilities.expand;
    const max = constraints?.maxPerSide;
    const largest = Math.max(...Object.values(this.margins));
    let scale = max && largest ? Math.min(this.scale, max / largest) : this.scale;
    if (constraints?.maxPixels) {
      const width = this.lens.width + this.margins.left + this.margins.right;
      const height = this.lens.height + this.margins.top + this.margins.bottom;
      scale = Math.min(scale, Math.sqrt((constraints.maxPixels - 1) / (width * height)));
    }
    return this.lens.frame(scale, this.selectedModel?.capabilities.size);
  }

  private fittedExpansion(frame: GenerationFrame, requested: GenerationExpansion): GenerationExpansion | null {
    const ratios = this.selectedModel?.capabilities.expand?.aspectRatios ?? [];
    const candidates = ratios.map((value) => {
      const aspect = ratio(value);
      const width = Math.max(frame.width, Math.ceil(frame.height * aspect));
      const height = Math.max(frame.height, Math.ceil(frame.width / aspect));
      const horizontal = width - frame.width, vertical = height - frame.height;
      return {
        left: Math.floor(horizontal / 2), right: Math.ceil(horizontal / 2),
        top: Math.floor(vertical / 2), bottom: Math.ceil(vertical / 2),
      };
    }).filter((candidate) => candidate.left >= requested.left && candidate.right >= requested.right &&
      candidate.top >= requested.top && candidate.bottom >= requested.bottom);
    return candidates.sort((a, b) =>
      (frame.width + a.left + a.right) * (frame.height + a.top + a.bottom) -
      (frame.width + b.left + b.right) * (frame.height + b.top + b.bottom))[0] ?? null;
  }

  private adjusted(frame: GenerationFrame): GenerationExpansion {
    const factorX = frame.width / frame.canonicalWidth;
    const factorY = frame.height / frame.canonicalHeight;
    let left = Math.round(this.margins.left * factorX), right = Math.round(this.margins.right * factorX);
    let top = Math.round(this.margins.top * factorY), bottom = Math.round(this.margins.bottom * factorY);
    const constraints = this.selectedModel?.capabilities.expand;
    if (constraints?.centered) {
      left = right = Math.max(left, right);
      top = bottom = Math.max(top, bottom);
    }
    if (constraints?.fitSource) {
      const fitted = this.fittedExpansion(frame, { left, right, top, bottom });
      if (fitted) return fitted;
    }
    if (constraints?.aspectRatios?.length) {
      const width = frame.width + left + right, height = frame.height + top + bottom;
      const chosen = constraints.aspectRatios.map(ratio).reduce((best, current) => {
        const area = (value: number) => Math.max(width, height * value) * Math.max(height, width / value);
        return area(current) < area(best) ? current : best;
      });
      const growWidth = Math.max(0, Math.ceil(height * chosen - width));
      const growHeight = Math.max(0, Math.ceil(width / chosen - height));
      left += Math.floor(growWidth / 2);
      right += Math.ceil(growWidth / 2);
      top += Math.floor(growHeight / 2);
      bottom += Math.ceil(growHeight / 2);
    }
    return { left, right, top, bottom };
  }

  protected override get expansion(): GenerationExpansion { return this.adjusted(this.frame); }

  override get outputFrame(): GenerationFrame {
    const frame = this.frame;
    const { left, right, top, bottom } = this.adjusted(frame);
    const outerWidth = frame.width + left + right, outerHeight = frame.height + top + bottom;
    const buckets = this.selectedModel?.capabilities.expand?.outputSizeBuckets ?? [];
    const bucket = buckets.length ? buckets.reduce((best, current) =>
      Math.abs(Math.log(current.width / current.height / (outerWidth / outerHeight))) <
      Math.abs(Math.log(best.width / best.height / (outerWidth / outerHeight))) ? current : best) : null;
    return {
      width: bucket?.width ?? outerWidth,
      height: bucket?.height ?? outerHeight,
      canonicalWidth: frame.canonicalWidth * outerWidth / frame.width,
      canonicalHeight: frame.canonicalHeight * outerHeight / frame.height,
      transform: multiply(frame.transform, [outerWidth / (bucket?.width ?? outerWidth), 0, 0,
        outerHeight / (bucket?.height ?? outerHeight), -left, -top]),
    };
  }

  override get sizeError(): string {
    const inputError = super.sizeError;
    if (inputError) return inputError;
    const output = this.outputFrame;
    if (Object.values(this.margins).every((value) => value === 0)) return 'Expand at least one side before generating.';
    const constraints: GenerationExpandConstraints = this.selectedModel?.capabilities.expand ?? {};
    if (constraints.fitSource) {
      const frame = this.frame;
      const factorX = frame.width / frame.canonicalWidth, factorY = frame.height / frame.canonicalHeight;
      const requested = {
        left: Math.round(this.margins.left * factorX), right: Math.round(this.margins.right * factorX),
        top: Math.round(this.margins.top * factorY), bottom: Math.round(this.margins.bottom * factorY),
      };
      if (!this.fittedExpansion(frame, requested)) return 'This model can only expand by changing the aspect ratio in one dimension.';
    }
    const max = constraints.maxPerSide;
    if (max && Object.values(this.expansion).some((value) => value > max)) return `This model can expand at most ${max} px per side.`;
    if (constraints.maxPixels && output.width * output.height >= constraints.maxPixels) return 'The expanded image exceeds this model’s pixel limit.';
    const limit = this.editor.gpu.device.limits.maxTextureDimension2D;
    if (output.width > limit || output.height > limit) return `The expanded image exceeds this GPU’s ${limit} px side limit.`;
    return '';
  }

  run(): Promise<void> { return this.generate(); }

  renderSpecific(container: HTMLElement): void {
    const promptField = document.createElement('label');
    promptField.className = 'field generation-prompt';
    const prompt = document.createElement('textarea');
    prompt.rows = 4;
    prompt.value = this.prompt;
    prompt.oninput = () => { this.prompt = prompt.value; this.settingsChanged(); };
    promptField.append(document.createTextNode('Prompt'), prompt);
    this.promptField = promptField;
    const margins = document.createElement('div');
    margins.className = 'generation-numbers';
    this.marginFields.clear();
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const field = document.createElement('label');
      field.className = 'field';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = '1';
      input.value = String(this.margins[side]);
      input.onchange = () => {
        if (Number.isFinite(input.valueAsNumber)) this.margins[side] = Math.max(0, Math.round(input.valueAsNumber));
        input.value = String(this.margins[side]);
        this.settingsChanged();
      };
      field.append(document.createTextNode(side[0].toUpperCase() + side.slice(1) + ' px'), input);
      margins.append(field);
      this.marginFields.set(side, input);
    }
    container.append(promptField, margins);
  }

  override syncUI(): void {
    if (this.promptField) this.promptField.hidden = !this.selectedModel?.capabilities.prompt;
    for (const [side, input] of this.marginFields) {
      if (document.activeElement !== input) input.value = String(this.margins[side]);
    }
  }

  private handlePoint(handle: Point): Point {
    const frame = this.outputFrame;
    const pixel = { x: (handle.x + 1) * frame.width / 2, y: (handle.y + 1) * frame.height / 2 };
    return this.editor.viewport.worldToScreen(transformPoint(frame.transform, pixel));
  }

  private hitHandle(screen: Point): Point | null {
    return HANDLES.find((handle) => {
      const point = this.handlePoint(handle);
      return Math.hypot(point.x - screen.x, point.y - screen.y) <= 9;
    }) ?? null;
  }

  pointerDown(pointer: ToolPointer): boolean {
    if (this.busy) return false;
    const handle = this.hitHandle(pointer.screen);
    if (!handle) return false;
    const frame = this.frame;
    this.gesture = { before: { ...this.margins }, frame, start: transformPoint(inverse(frame.transform), pointer.world), handle };
    return true;
  }

  pointerMove(pointer: ToolPointer): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const current = transformPoint(inverse(gesture.frame.transform), pointer.world);
    const dx = (current.x - gesture.start.x) * gesture.frame.canonicalWidth / gesture.frame.width;
    const dy = (current.y - gesture.start.y) * gesture.frame.canonicalHeight / gesture.frame.height;
    const { before, handle } = gesture;
    this.margins = {
      left: handle.x < 0 ? Math.max(0, Math.round(before.left - dx)) : before.left,
      right: handle.x > 0 ? Math.max(0, Math.round(before.right + dx)) : before.right,
      top: handle.y < 0 ? Math.max(0, Math.round(before.top - dy)) : before.top,
      bottom: handle.y > 0 ? Math.max(0, Math.round(before.bottom + dy)) : before.bottom,
    };
    this.settingsChanged();
  }

  finishGesture(): void { this.gesture = null; }
  cancelGesture(): void {
    if (!this.gesture) return;
    this.margins = this.gesture.before;
    this.gesture = null;
    this.settingsChanged();
  }
  get editingFrame(): boolean { return !!this.gesture; }
  wantsPointer(pointer: ToolPointer): boolean { return !this.busy && !!this.hitHandle(pointer.screen); }
  hover(pointer: ToolPointer): void {
    const handle = this.hitHandle(pointer.screen);
    this.editor.canvas.style.cursor = handle && handle.x && handle.y ? handle.x === handle.y ? 'nwse-resize' : 'nesw-resize' :
      handle?.x ? 'ew-resize' : 'ns-resize';
  }

  drawOutputFrame(): void {
    const corners = [HANDLES[0], HANDLES[2], HANDLES[4], HANDLES[6]].map((handle) => this.handlePoint(handle));
    const overlay = this.editor.overlay;
    const polygon = document.createElementNS(overlay.namespaceURI, 'polygon');
    polygon.setAttribute('points', corners.map((point) => `${point.x},${point.y}`).join(' '));
    polygon.setAttribute('class', 'generation-output-frame');
    overlay.append(polygon);
    if (this.busy) return;
    for (const handle of HANDLES) {
      const point = this.handlePoint(handle);
      const node = document.createElementNS(overlay.namespaceURI, 'rect');
      for (const [name, value] of Object.entries({ x: point.x - 3, y: point.y - 3, width: 6, height: 6 })) node.setAttribute(name, String(value));
      node.setAttribute('class', 'generation-output-handle');
      overlay.append(node);
    }
  }
}
