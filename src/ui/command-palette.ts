import type { ActionRegistry, CommandAction } from '../actions';
import type { Editor } from '../editor';
import { icon } from './icons';
import type { IconName } from './icons';

export interface PaletteItem {
  id: string;
  label: string;
  category: string;
  shortcut: string;
  enabled: boolean;
  icon: IconName | null;
  searchText: string;
  execute(): void;
}

export interface PaletteSource {
  priority: number;
  items(): PaletteItem[];
}

interface RankedItem {
  item: PaletteItem;
  score: number;
  order: number;
}

const EXACT_ICONS: Readonly<Record<string, IconName>> = {
  'file.new': 'document',
  'file.open': 'folder',
  'file.save': 'document',
  'file.save-as': 'document',
  'file.export-png': 'image',
  'file.export-webp': 'image',
  'file.import': 'image',
  'file.close': 'close',
  'history.undo': 'undo',
  'history.redo': 'redo',
  'layer.new': 'plus',
  'layer.new-text': 'text',
  'layer.new-sized': 'image',
  'layer.delete': 'trash',
  'group.new': 'layers',
  'drawing.erase': 'eraser',
  'colors.reset': 'colors',
  'colors.swap': 'swap',
  'tool.brush': 'brush',
  'tool.rectangle': 'rectangle',
  'tool.ellipse': 'ellipse',
  'tool.freehand-lasso': 'freehand-lasso',
  'tool.polygon-lasso': 'polygon-lasso',
  'tool.fill': 'fill',
  'tool.clone-stamp': 'clone-stamp',
  'tool.healing-brush': 'healing-brush',
  'tool.text': 'text',
  'tool.crop': 'crop',
  'tool.transform': 'transform',
  'tool.eyedropper': 'eyedropper',
  'tool.generation': 'generate',
  'generation.generate': 'generate',
  'generation.cancel': 'close',
  'selection.remove': 'remove',
  'settings.open': 'settings',
  'settings.canvas-background': 'settings',
};

function actionIcon(id: string): IconName | null {
  if (EXACT_ICONS[id]) return EXACT_ICONS[id];
  if (id.startsWith('filter.')) return 'settings';
  if (id.startsWith('selection.')) return 'selection';
  if (id.startsWith('layer.') || id.startsWith('mask.')) return 'layers';
  if (id.startsWith('transform.')) return 'transform';
  if (id.startsWith('crop.')) return 'crop';
  if (id.startsWith('polygon.')) return 'polygon-lasso';
  if (id.startsWith('generation.')) return 'generate';
  return null;
}

class CommandSource implements PaletteSource {
  readonly priority = 0;

  constructor(private readonly actions: ActionRegistry) {}

  items(): PaletteItem[] {
    return this.actions.commandItems().map((command: CommandAction) => ({
      ...command,
      icon: actionIcon(command.id),
      searchText: `${command.label} ${command.category} ${command.id}`,
      execute: () => this.actions.execute(command.id),
    }));
  }
}

class OpenDocumentSource implements PaletteSource {
  readonly priority = 24;

  constructor(private readonly editor: Editor) {}

  items(): PaletteItem[] {
    return this.editor.documents.map((document) => ({
      id: `document.${document.id}`,
      label: document.name,
      category: document.dirty ? 'Open documents · Unsaved changes' : 'Open documents',
      shortcut: '',
      enabled: true,
      icon: 'document',
      searchText: `${document.name} open document tab`,
      execute: () => this.editor.run(() => this.editor.activateDocument(document)),
    }));
  }
}

function fuzzyScore(needle: string, haystack: string): number | null {
  let position = 0;
  let previous = -2;
  let score = 0;
  for (const character of needle) {
    const index = haystack.indexOf(character, position);
    if (index < 0) return null;
    const boundary = index === 0 || /[\s./›_-]/.test(haystack[index - 1]);
    score += boundary ? 12 : 1;
    if (index === previous + 1) score += 7;
    score -= Math.min(6, index - position);
    previous = index;
    position = index + 1;
  }
  return score;
}

function formatShortcut(shortcut: string): string {
  const names: Readonly<Record<string, string>> = {
    ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter', escape: 'Esc', insert: 'Insert', delete: 'Delete',
    backspace: 'Backspace', space: 'Space', tab: 'Tab', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', f2: 'F2',
  };
  return shortcut.split('+').map((part) => names[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join('+');
}

export class CommandPalette {
  private readonly dialog = document.querySelector<HTMLDialogElement>('#command-palette')!;
  private readonly search = document.querySelector<HTMLInputElement>('#command-search')!;
  private readonly results = document.querySelector<HTMLElement>('#command-results')!;
  private readonly empty = document.querySelector<HTMLElement>('#command-empty')!;
  private readonly sources: readonly PaletteSource[];
  private items: PaletteItem[] = [];
  private active = 0;

  constructor(editor: Editor) {
    this.sources = [new OpenDocumentSource(editor), new CommandSource(editor.actions)];
    this.search.oninput = () => this.filter();
    this.search.onkeydown = (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.move(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.execute(this.active);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.dialog.close();
      } else if (event.key.toLowerCase() === 'p' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.search.select();
      }
      event.stopPropagation();
    };
    this.dialog.onpointerdown = (event) => { if (event.target === this.dialog) this.dialog.close(); };
  }

  open(): void {
    if (!this.dialog.open) this.dialog.showModal();
    this.search.value = '';
    this.filter();
    this.search.focus();
    this.search.select();
  }

  private filter(): void {
    const query = this.search.value.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    let order = 0;
    const ranked = this.sources.flatMap((source): RankedItem[] => source.items().flatMap((item): RankedItem[] => {
      const itemOrder = order++;
      if (!tokens.length) return [{ item, score: source.priority, order: itemOrder }];
      const label = item.label.toLowerCase();
      const haystack = item.searchText.toLowerCase();
      let score = source.priority + (label.startsWith(query) ? 80 : label.includes(query) ? 45 : 0);
      for (const token of tokens) {
        const tokenScore = fuzzyScore(token, haystack);
        if (tokenScore === null) return [];
        score += tokenScore;
      }
      return [{ item, score, order: itemOrder }];
    }));
    ranked.sort((a, b) => b.score - a.score || a.order - b.order);
    this.items = ranked.map((entry) => entry.item);
    this.active = Math.max(0, this.items.findIndex((item) => item.enabled));
    this.render();
  }

  private render(): void {
    this.empty.hidden = this.items.length > 0;
    const rows = this.items.map((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.id = `command-result-${index}`;
      row.className = 'command-result';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === this.active));
      row.disabled = !item.enabled;
      const glyph = document.createElement('span');
      glyph.className = 'command-result-icon';
      if (item.icon) glyph.append(icon(item.icon));
      const copy = document.createElement('span');
      copy.className = 'command-result-copy';
      const label = document.createElement('strong');
      label.textContent = item.label;
      const category = document.createElement('small');
      category.textContent = item.category;
      copy.append(label, category);
      const shortcut = document.createElement('kbd');
      shortcut.textContent = formatShortcut(item.shortcut);
      row.append(glyph, copy, shortcut);
      row.onpointerenter = () => this.select(index, false);
      row.onclick = () => this.execute(index);
      return row;
    });
    this.results.replaceChildren(...rows);
    this.search.setAttribute('aria-activedescendant', this.items.length ? `command-result-${this.active}` : '');
  }

  private move(offset: number): void {
    if (!this.items.length) return;
    let index = this.active;
    do index = (index + offset + this.items.length) % this.items.length;
    while (!this.items[index].enabled && index !== this.active);
    this.select(index, true);
  }

  private select(index: number, scroll: boolean): void {
    if (!this.items[index]?.enabled) return;
    this.active = index;
    const rows = [...this.results.querySelectorAll<HTMLElement>('.command-result')];
    rows.forEach((row, rowIndex) => row.setAttribute('aria-selected', String(rowIndex === index)));
    this.search.setAttribute('aria-activedescendant', `command-result-${index}`);
    if (scroll) rows[index]?.scrollIntoView({ block: 'nearest' });
  }

  private execute(index: number): void {
    const item = this.items[index];
    if (!item?.enabled) return;
    this.dialog.close();
    item.execute();
  }
}
