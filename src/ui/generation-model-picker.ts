import type { GenerationModel } from '../generation/provider';
import { icon } from './icons';

type RatingKey = 'affordability' | 'speed' | 'quality';
type SortKey = 'name' | 'publisher' | 'platform' | RatingKey;

export class GenerationModelPicker {
  readonly button = document.createElement('button');
  private readonly dialog = document.createElement('dialog');
  private readonly search = document.createElement('input');
  private readonly head = document.createElement('thead');
  private readonly body = document.createElement('tbody');
  private models: readonly GenerationModel[] = [];
  private selected = '';
  private sortKey: SortKey = 'quality';
  private ascending = false;

  constructor(private readonly select: (id: string) => void) {
    this.button.type = 'button';
    this.button.className = 'generation-model-button';
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.onclick = () => this.open();
    this.dialog.className = 'generation-model-dialog';
    this.dialog.setAttribute('aria-label', 'Choose image model');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = 'Choose image model';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button';
    close.setAttribute('aria-label', 'Close model picker');
    close.append(icon('close'));
    close.onclick = () => this.dialog.close();
    header.append(title, close);
    this.search.type = 'search';
    this.search.placeholder = 'Search models';
    this.search.setAttribute('aria-label', 'Search image models');
    this.search.oninput = () => this.render();
    const tableWrap = document.createElement('div');
    tableWrap.className = 'generation-model-table-wrap';
    const table = document.createElement('table');
    table.title = 'Approximate relative ratings. Results vary with image size, quality settings, and task.';
    table.append(this.head, this.body);
    tableWrap.append(table);
    this.dialog.append(header, this.search, tableWrap);
    document.body.append(this.dialog);
  }

  update(models: readonly GenerationModel[], selected: string): void {
    this.models = models;
    this.selected = selected;
    const model = models.find((entry) => entry.id === selected);
    const text = document.createElement('span');
    text.textContent = model?.displayName ?? model?.label ?? 'No models available';
    this.button.replaceChildren(text, icon('chevron-down'));
    this.button.disabled = !models.length;
    if (this.dialog.open) this.render();
  }

  private open(): void {
    if (!this.models.length || this.dialog.open) return;
    this.search.value = '';
    this.render();
    this.dialog.showModal();
    this.search.focus();
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
    const models = this.models.filter((model) => {
      const searchable = [model.displayName ?? model.label, model.id, model.publisherName, model.platformName]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    }).sort((left, right) => this.compare(left, right));
    this.body.replaceChildren(...models.map((model) => this.row(model)));
    if (!models.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.className = 'generation-model-empty';
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

  private compare(left: GenerationModel, right: GenerationModel): number {
    let result: number;
    if (this.sortKey === 'name') {
      result = (left.displayName ?? left.label).localeCompare(right.displayName ?? right.label);
    } else if (this.sortKey === 'publisher') {
      result = (left.publisherName ?? '?').localeCompare(right.publisherName ?? '?');
    } else if (this.sortKey === 'platform') {
      result = (left.platformName ?? '?').localeCompare(right.platformName ?? '?');
    } else {
      const leftRating = left.ratings?.[this.sortKey];
      const rightRating = right.ratings?.[this.sortKey];
      if (leftRating === undefined || rightRating === undefined) {
        if (leftRating === rightRating) {
          return (left.displayName ?? left.label).localeCompare(right.displayName ?? right.label);
        }
        return leftRating === undefined ? 1 : -1;
      }
      result = leftRating - rightRating;
    }
    if (!result) result = (left.displayName ?? left.label).localeCompare(right.displayName ?? right.label);
    return this.ascending ? result : -result;
  }

  private row(model: GenerationModel): HTMLTableRowElement {
    const row = document.createElement('tr');
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
    name.append(displayName, id);
    const publisher = document.createElement('td');
    publisher.textContent = model.publisherName ?? '?';
    const platform = document.createElement('td');
    platform.textContent = model.platformName ?? '?';
    row.append(name, publisher, platform, this.rating(model, 'affordability'),
      this.rating(model, 'speed'), this.rating(model, 'quality'));
    return row;
  }

  private rating(model: GenerationModel, key: RatingKey): HTMLTableCellElement {
    const cell = document.createElement('td');
    const rating = model.ratings?.[key];
    if (typeof rating !== 'number') {
      cell.textContent = '?';
      cell.className = 'generation-model-unknown';
      return cell;
    }
    cell.className = 'generation-model-rating';
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
