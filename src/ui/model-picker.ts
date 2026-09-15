import type { GenerationModelRatings, GenerationModelType } from '../generation/provider';
import { icon } from './icons';

type RatingKey = 'affordability' | 'speed' | 'quality';
type SortKey = 'name' | 'publisher' | 'platform' | RatingKey;

export interface ModelPickerItem {
  id: string;
  label: string;
  displayName?: string;
  platformName?: string;
  publisherName?: string;
  ratings?: GenerationModelRatings;
  tags?: readonly string[];
  types?: readonly GenerationModelType[];
}

const TYPE_LABELS: Record<GenerationModelType, string> = {
  'general-editing': 'General editing',
  'generate-from-image': 'Generate from image',
  'fill-inpaint': 'Fill and inpaint',
  'background-removal': 'Background removal',
  'object-removal-mask': 'Object removal by mask',
  'object-removal-prompt': 'Object removal by prompt',
  'expand-reframe': 'Expand and reframe',
  restore: 'Restore',
  upscale: 'Upscale',
  'lighting-color': 'Lighting and color',
  'style-transform': 'Style and transform',
  'subject-product': 'Subject and product',
  'selection-analysis': 'Selection and analysis',
  'structure-extraction': 'Structure and extraction',
};

export class ModelPicker {
  readonly button = document.createElement('button');
  private readonly dialog = document.createElement('dialog');
  private readonly search = document.createElement('input');
  private readonly typeFilter = document.createElement('select');
  private readonly tagFilter = document.createElement('select');
  private readonly head = document.createElement('thead');
  private readonly body = document.createElement('tbody');
  private models: readonly ModelPickerItem[] = [];
  private modelsSignature = '';
  private selected = '';
  private sortKey: SortKey = 'quality';
  private ascending = false;

  constructor(private readonly select: (id: string) => void) {
    this.button.type = 'button';
    this.button.className = 'model-picker-button';
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.onclick = () => this.open();
    this.dialog.className = 'model-picker-dialog';
    this.dialog.setAttribute('aria-label', 'Choose model');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = 'Choose model';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button';
    close.setAttribute('aria-label', 'Close model picker');
    close.append(icon('close'));
    close.onclick = () => this.dialog.close();
    header.append(title, close);
    this.search.type = 'search';
    this.search.placeholder = 'Search models';
    this.search.setAttribute('aria-label', 'Search models');
    this.search.oninput = () => this.render();
    this.typeFilter.onchange = () => this.render();
    this.tagFilter.onchange = () => this.render();
    const filters = document.createElement('div');
    filters.className = 'model-picker-filters';
    filters.append(this.search, this.typeFilter, this.tagFilter);
    const tableWrap = document.createElement('div');
    tableWrap.className = 'model-picker-table-wrap';
    const table = document.createElement('table');
    table.title = 'Approximate relative ratings. Results vary with image size, quality settings, and task.';
    table.append(this.head, this.body);
    tableWrap.append(table);
    this.dialog.append(header, filters, tableWrap);
    document.body.append(this.dialog);
  }

  update(models: readonly ModelPickerItem[], selected: string): void {
    // Generator updates run every canvas frame and supply a fresh filtered array.
    // Preserve row nodes between pointer-down and click when their data is unchanged.
    const signature = JSON.stringify(models.map((model) => [
      model.id, model.label, model.displayName, model.platformName, model.publisherName,
      model.ratings, model.tags, model.types,
    ]));
    const modelsChanged = signature !== this.modelsSignature;
    const selectionChanged = selected !== this.selected;
    this.models = models;
    this.selected = selected;
    if (!modelsChanged && !selectionChanged) return;
    this.modelsSignature = signature;
    const model = models.find((entry) => entry.id === selected);
    const text = document.createElement('span');
    text.textContent = model?.displayName ?? model?.label ?? 'No models available';
    this.button.replaceChildren(text, icon('chevron-down'));
    this.button.disabled = !models.length;
    if (this.dialog.open) {
      if (modelsChanged) {
        this.populateFilters();
        this.render();
      } else {
        for (const row of this.body.rows) row.classList.toggle('selected', row.dataset.modelId === selected);
      }
    }
  }

  private open(): void {
    if (!this.models.length || this.dialog.open) return;
    this.search.value = '';
    this.typeFilter.value = '';
    this.tagFilter.value = '';
    this.populateFilters();
    this.render();
    this.dialog.showModal();
    this.search.focus();
  }

  private populateFilters(): void {
    const currentType = this.typeFilter.value;
    const currentTag = this.tagFilter.value;
    const types = [...new Set(this.models.flatMap((model) => model.types ?? []))].sort((a, b) => TYPE_LABELS[a].localeCompare(TYPE_LABELS[b]));
    const tags = [...new Set(this.models.flatMap((model) => model.tags ?? []))].sort((a, b) => a.localeCompare(b));
    this.typeFilter.replaceChildren(new Option('All types', ''), ...types.map((type) => new Option(TYPE_LABELS[type], type)));
    this.tagFilter.replaceChildren(new Option('All tags', ''), ...tags.map((tag) => new Option(tag, tag)));
    if (types.includes(currentType as GenerationModelType)) this.typeFilter.value = currentType;
    if (tags.includes(currentTag)) this.tagFilter.value = currentTag;
  }

  private sort(key: SortKey): void {
    if (this.sortKey === key) this.ascending = !this.ascending;
    else {
      this.sortKey = key;
      this.ascending = key === 'name' || key === 'publisher' || key === 'platform';
    }
    this.render();
  }

  private render(): void {
    this.renderHead();
    const terms = this.search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const type = this.typeFilter.value;
    const tag = this.tagFilter.value;
    const models = this.models.filter((model) => {
      const searchable = [model.displayName ?? model.label, model.id, model.publisherName, model.platformName, ...(model.tags ?? [])]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      return (!type || model.types?.includes(type as GenerationModelType)) && (!tag || model.tags?.includes(tag)) &&
        terms.every((term) => searchable.includes(term));
    }).sort((left, right) => this.compare(left, right));
    this.body.replaceChildren(...models.map((model) => this.row(model)));
    if (!models.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.className = 'model-picker-empty';
      cell.textContent = 'No matching models';
      row.append(cell);
      this.body.append(row);
    }
  }

  private renderHead(): void {
    const row = document.createElement('tr');
    for (const [label, key] of [
      ['Model', 'name'],
      ['Publisher', 'publisher'],
      ['Platform', 'platform'],
      ['Affordability', 'affordability'],
      ['Speed', 'speed'],
      ['Quality', 'quality'],
    ] as const) {
      const cell = document.createElement('th');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label + (this.sortKey === key ? this.ascending ? ' ↑' : ' ↓' : '');
      button.onclick = () => this.sort(key);
      cell.append(button);
      row.append(cell);
    }
    this.head.replaceChildren(row);
  }

  private compare(left: ModelPickerItem, right: ModelPickerItem): number {
    let result: number;
    if (this.sortKey === 'name') result = (left.displayName ?? left.label).localeCompare(right.displayName ?? right.label);
    else if (this.sortKey === 'publisher') result = (left.publisherName ?? '?').localeCompare(right.publisherName ?? '?');
    else if (this.sortKey === 'platform') result = (left.platformName ?? '?').localeCompare(right.platformName ?? '?');
    else {
      const leftRating = left.ratings?.[this.sortKey];
      const rightRating = right.ratings?.[this.sortKey];
      const leftKnown = typeof leftRating === 'number';
      const rightKnown = typeof rightRating === 'number';
      if (!leftKnown || !rightKnown) {
        if (leftKnown === rightKnown) return (left.displayName ?? left.label).localeCompare(right.displayName ?? right.label);
        return leftKnown ? -1 : 1;
      }
      result = leftRating - rightRating;
    }
    if (!result) result = (left.displayName ?? left.label).localeCompare(right.displayName ?? right.label);
    return this.ascending ? result : -result;
  }

  private row(model: ModelPickerItem): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.dataset.modelId = model.id;
    row.classList.toggle('selected', model.id === this.selected);
    row.tabIndex = 0;
    row.onclick = () => { this.select(model.id); this.dialog.close(); };
    row.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        row.click();
      }
    };
    const name = document.createElement('td');
    const displayName = document.createElement('strong');
    displayName.textContent = model.displayName ?? model.label;
    const id = document.createElement('small');
    id.textContent = model.id;
    const tags = document.createElement('div');
    tags.className = 'model-tags';
    tags.append(...(model.tags ?? []).slice(0, 4).map((tag) => {
      const chip = document.createElement('span');
      chip.textContent = tag;
      return chip;
    }));
    name.append(displayName, id, tags);
    const publisher = document.createElement('td');
    publisher.textContent = model.publisherName ?? '?';
    const platform = document.createElement('td');
    platform.textContent = model.platformName ?? '?';
    row.append(name, publisher, platform, this.rating(model, 'affordability'), this.rating(model, 'speed'), this.rating(model, 'quality'));
    return row;
  }

  private rating(model: ModelPickerItem, key: RatingKey): HTMLTableCellElement {
    const cell = document.createElement('td');
    const rating = model.ratings?.[key];
    if (typeof rating !== 'number') {
      cell.textContent = '?';
      cell.className = 'model-picker-unknown';
      return cell;
    }
    cell.className = 'model-picker-rating';
    const filled = document.createElement('span');
    filled.textContent = '★'.repeat(rating);
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = '★'.repeat(5 - rating);
    const provisional = model.ratings?.provisional?.includes(key) ? ' Provisional estimate.' : '';
    cell.title = `${rating} of 5. Approximate relative rating.${provisional}`;
    cell.setAttribute('aria-label', `${rating} of 5`);
    cell.append(filled, empty);
    return cell;
  }
}
