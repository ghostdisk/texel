import type { Gpu, GpuFrame } from '../gpu/device';
import { drawFilterSliderInput } from './controls';
import { icon } from '../ui/icons';
import type { QuadRenderer } from '../gpu/quad';
import type { Surface } from '../gpu/surface';
import type { MaskInput } from '../gpu/mask';
import type { LayerChoice } from '../ui/layer-select';
import type { Rect } from '../model/geometry';
import type { JsonObject, UndoDirection, UndoOperation, UndoTarget } from '../history/undo';

export interface SerializedFilter extends JsonObject {
  id: string;
  kind: string;
  enabled: boolean;
  mix: number;
  properties: JsonObject;
}

export interface FilterRenderContext {
  gpu: Gpu;
  frame: GpuFrame;
  quads: QuadRenderer;
  channels: 1 | 4;
  surface(key: string, bounds: Rect, scale: number): Surface;
  layer(id: string): MaskInput | null;
}

export interface FilterUIContext {
  histogram?(): Promise<Uint32Array>;
  layers?(): LayerChoice[];
  begin(label: string): void;
  preview(change: () => void): void;
  commit(): void;
  remove(): void;
  apply?(): void;
}

export abstract class Filter implements UndoTarget {
  abstract readonly kind: string;
  abstract readonly label: string;
  enabled = true;
  mix = 1;
  private collapsed = false;

  constructor(readonly id: string = crypto.randomUUID()) {}

  dependencies(): readonly string[] { return []; }
  remapDependencies(_ids: ReadonlyMap<string, string>): void {}

  abstract render(context: FilterRenderContext, input: Surface): Surface;
  abstract outputBounds(input: Rect): Rect;
  protected abstract properties(): JsonObject;
  protected abstract loadProperties(properties: JsonObject): void;
  protected abstract drawParameters(container: HTMLElement, context: FilterUIContext): void;

  serialize(): SerializedFilter { return { id: this.id, kind: this.kind, enabled: this.enabled, mix: this.mix, properties: this.properties() }; }

  deserialize(data: SerializedFilter): void {
    if (data.kind !== this.kind || data.id !== this.id) throw new Error('Filter identity does not match the serialized data.');
    const mix = data.mix ?? 1;
    if (typeof mix !== 'number' || !Number.isFinite(mix) || mix < 0 || mix > 1) throw new Error('Filter Mix must be between 0 and 1.');
    this.loadProperties(data.properties);
    this.mix = mix;
    this.enabled = data.enabled;
  }

  applyUndo(operation: UndoOperation, direction: UndoDirection): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'filter' || payload.targetId !== this.id || payload.action !== 'state') throw new Error('Unsupported filter undo operation.');
    this.deserialize(payload.data.filter as SerializedFilter);
  }

  drawUI(container: HTMLElement, context: FilterUIContext): void {
    container.className = 'filter';
    const header = document.createElement('div');
    header.className = 'filter-header';
    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'filter-collapse';
    collapse.append(icon('chevron-down'));
    collapse.setAttribute('aria-controls', `filter-details-${this.id}`);
    const grip = document.createElement('span');
    grip.className = 'filter-grip';
    grip.append(icon('grip'));
    grip.setAttribute('aria-hidden', 'true');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = this.enabled;
    toggle.setAttribute('aria-label', `Enable ${this.label}`);
    toggle.onchange = () => {
      context.begin(`Toggle ${this.label}`);
      context.preview(() => { this.enabled = toggle.checked; });
      context.commit();
    };
    const title = document.createElement('span');
    title.textContent = this.label;
    title.className = 'filter-title';
    const remove = document.createElement('button');
    remove.append(icon('close'));
    remove.setAttribute('aria-label', `Remove ${this.label}`);
    remove.title = `Remove ${this.label}`;
    remove.onclick = context.remove;
    header.append(collapse, grip, toggle, title);
    if (context.apply) {
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'filter-apply';
      apply.textContent = 'Apply';
      apply.title = 'Bake this filter into the layer pixels';
      apply.onclick = (event) => { event.stopPropagation(); context.apply?.(); };
      header.append(apply);
    }
    header.append(remove);
    const body = document.createElement('div');
    body.id = `filter-details-${this.id}`;
    body.className = 'filter-body';
    container.append(header);
    const drawDetails = () => {
      container.classList.toggle('filter-collapsed', this.collapsed);
      collapse.setAttribute('aria-expanded', String(!this.collapsed));
      collapse.setAttribute('aria-label', `${this.collapsed ? 'Expand' : 'Collapse'} ${this.label}`);
      collapse.title = this.collapsed ? 'Expand details' : 'Collapse details';
      body.replaceChildren();
      if (this.collapsed) { body.remove(); return; }
      const mix = document.createElement('div');
      mix.className = 'filter-mix';
      drawFilterSliderInput(mix, context, {
        label: 'Mix', min: 0, max: 100, step: 1, unit: '%',
        get: () => this.mix * 100, set: (value) => { this.mix = value / 100; },
      });
      body.append(mix);
      container.append(body);
      this.drawParameters(body, context);
    };
    collapse.onclick = (event) => {
      event.stopPropagation();
      this.collapsed = !this.collapsed;
      context.commit();
      if (container.isConnected) drawDetails();
    };
    drawDetails();
  }
}

export interface FilterDefinition {
  kind: string;
  label: string;
  group?: string;
  create(id?: string): Filter;
}

export class FilterRegistry {
  private definitions = new Map<string, FilterDefinition>();

  register(definition: FilterDefinition): void {
    if (this.definitions.has(definition.kind)) throw new Error(`Duplicate filter kind: ${definition.kind}`);
    this.definitions.set(definition.kind, definition);
  }

  list(): readonly FilterDefinition[] { return [...this.definitions.values()]; }

  create(kind: string, id?: string): Filter {
    const definition = this.definitions.get(kind);
    if (!definition) throw new Error(`Unknown filter kind: ${kind}`);
    return definition.create(id);
  }

  deserialize(data: SerializedFilter): Filter {
    const filter = this.create(data.kind, data.id);
    filter.deserialize(data);
    return filter;
  }
}
