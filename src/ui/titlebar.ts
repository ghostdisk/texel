import { ActionRegistry } from '../actions';
import type { MenuAction } from '../actions';

interface ActionRow {
  kind: 'action';
  action: MenuAction;
}

interface SubmenuRow {
  kind: 'submenu';
  label: string;
  actions: MenuAction[];
}

interface SeparatorRow {
  kind: 'separator';
}

type MenuRow = ActionRow | SubmenuRow | SeparatorRow;

const GENERATOR_ICONS: Record<string, string> = {
  'generator.image': new URL('../../assets/icons/icon-generate-image.png', import.meta.url).href,
  'generator.background-removal': new URL('../../assets/icons/icon-remove-background.png', import.meta.url).href,
  'generator.object-removal': new URL('../../assets/icons/icon-remove-object.png', import.meta.url).href,
  'generator.inpaint': new URL('../../assets/icons/icon-inpaint.png', import.meta.url).href,
  'generator.enhance': new URL('../../assets/icons/icon-enhance.png', import.meta.url).href,
  'generator.expand': new URL('../../assets/icons/icon-uncrop.png', import.meta.url).href,
  'generator.extract-structure': new URL('../../assets/icons/icon-extract.png', import.meta.url).href,
  'generator.relight-recolor': new URL('../../assets/icons/icon-relight.png', import.meta.url).href,
};

export class TitleBar {
  private readonly buttons: HTMLButtonElement[];
  private readonly generatorButton: HTMLButtonElement | null;
  private readonly popup = document.createElement('div');
  private activeButton: HTMLButtonElement | null = null;
  private submenuTimer = 0;

  constructor(private readonly actions: ActionRegistry) {
    this.buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-menu]')];
    this.generatorButton = document.querySelector<HTMLButtonElement>('#generator-menu-button');
    this.popup.className = 'app-menu-popup';
    this.popup.setAttribute('role', 'menu');
    this.popup.hidden = true;
    document.querySelector('.titlebar')?.append(this.popup);
    for (const [index, button] of this.buttons.entries()) {
      button.onclick = () => this.toggle(button);
      button.onpointerenter = () => {
        if (!this.activeButton || this.activeButton === button) return;
        this.open(button);
      };
      button.onkeydown = (event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const next = this.buttons[(index + this.buttons.length + (event.key === 'ArrowRight' ? 1 : -1)) % this.buttons.length];
          next.focus();
          if (this.activeButton) this.open(next);
        } else if (event.key === 'ArrowDown') { event.preventDefault(); this.open(button, true); }
        else if (event.key === 'Escape') this.close();
        if ([' ', 'Enter', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) event.stopPropagation();
      };
    }
    if (this.generatorButton) {
      this.generatorButton.onclick = () => this.toggle(this.generatorButton!);
      this.generatorButton.onkeydown = (event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); this.open(this.generatorButton!, true); }
        else if (event.key === 'Escape') this.close();
        if ([' ', 'Enter', 'ArrowDown', 'Escape'].includes(event.key)) event.stopPropagation();
      };
    }
    document.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (target instanceof Node && (this.popup.contains(target) || this.buttons.some((button) => button.contains(target)) || this.generatorButton?.contains(target))) return;
      this.close();
    });
    window.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || document.querySelector('dialog[open], [popover]:popover-open')) return;
      if (event.key === 'Escape' && this.activeButton) { event.preventDefault(); this.close(); return; }
      if (event.key === 'F10' && !event.shiftKey) { event.preventDefault(); this.buttons[0]?.focus(); }
      const target = event.altKey && !event.ctrlKey && !event.metaKey ?
        this.buttons.find((button) => button.dataset.mnemonic === event.key.toLowerCase()) : null;
      if (target) { event.preventDefault(); target.focus(); this.open(target, true); }
    });
    const focus = () => document.body.classList.toggle('window-inactive', !document.hasFocus());
    window.addEventListener('focus', focus);
    window.addEventListener('blur', () => { focus(); this.close(); });
    focus();
  }

  private rows(items: MenuAction[]): MenuRow[] {
    const rows: MenuRow[] = [];
    for (const action of items) {
      if (action.submenu) {
        let row = rows.find((candidate): candidate is SubmenuRow => candidate.kind === 'submenu' && candidate.label === action.submenu);
        if (!row) {
          if (action.separatorBefore && rows.at(-1)?.kind !== 'separator') rows.push({ kind: 'separator' });
          row = { kind: 'submenu', label: action.submenu, actions: [] };
          rows.push(row);
        }
        row.actions.push(action);
      } else {
        if (action.separatorBefore && rows.at(-1)?.kind !== 'separator') rows.push({ kind: 'separator' });
        rows.push({ kind: 'action', action });
      }
    }
    return rows;
  }

  private actionButton(action: MenuAction): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'app-menu-item';
    button.type = 'button';
    button.role = 'menuitem';
    button.disabled = !action.enabled;
    const label = document.createElement('span');
    label.className = 'app-menu-item-label';
    const iconName = GENERATOR_ICONS[action.id];
    if (iconName) {
      button.classList.add('generator-menu-item');
      const icon = document.createElement('img');
      icon.className = 'generator-menu-icon';
      icon.src = iconName;
      icon.alt = '';
      label.append(icon);
    }
    label.append(document.createTextNode(action.label));
    const shortcut = document.createElement('kbd');
    shortcut.textContent = action.shortcut;
    button.append(label, shortcut);
    button.onclick = () => { this.close(); this.actions.execute(action.id); };
    return button;
  }

  private renderRows(container: HTMLElement, rows: MenuRow[]): void {
    for (const row of rows) {
      if (row.kind === 'separator') {
        const separator = document.createElement('div');
        separator.className = 'app-menu-separator';
        separator.role = 'separator';
        container.append(separator);
      } else if (row.kind === 'action') container.append(this.actionButton(row.action));
      else {
        const wrapper = document.createElement('div');
        wrapper.className = 'app-menu-submenu-row';
        const button = document.createElement('button');
        button.className = 'app-menu-item';
        button.type = 'button';
        button.role = 'menuitem';
        button.setAttribute('aria-haspopup', 'menu');
        const label = document.createElement('span');
        label.textContent = row.label;
        const arrow = document.createElement('span');
        arrow.className = 'app-menu-arrow';
        arrow.textContent = '›';
        button.append(label, arrow);
        const submenu = document.createElement('div');
        submenu.className = 'app-menu-popup app-submenu';
        submenu.setAttribute('role', 'menu');
        this.renderRows(submenu, row.actions.map((action) => ({ kind: 'action', action })));
        wrapper.append(button, submenu);
        wrapper.onpointerenter = () => {
          window.clearTimeout(this.submenuTimer);
          this.submenuTimer = window.setTimeout(() => {
            this.popup.querySelectorAll('.app-menu-submenu-row.open').forEach((item) => item.classList.remove('open'));
            wrapper.classList.add('open');
          }, 55);
        };
        wrapper.onpointerleave = () => {
          window.clearTimeout(this.submenuTimer);
          this.submenuTimer = window.setTimeout(() => wrapper.classList.remove('open'), 100);
        };
        container.append(wrapper);
      }
    }
  }

  private toggle(button: HTMLButtonElement): void {
    if (this.activeButton === button) this.close();
    else this.open(button);
  }

  private open(button: HTMLButtonElement, focusFirst = false): void {
    window.clearTimeout(this.submenuTimer);
    this.activeButton?.setAttribute('aria-expanded', 'false');
    this.activeButton = button;
    button.setAttribute('aria-expanded', 'true');
    const menu = this.actions.menus().find((candidate) => candidate.label === (button === this.generatorButton ? 'Generators' : button.dataset.menu));
    this.popup.replaceChildren();
    if (menu) this.renderRows(this.popup, this.rows(menu.items));
    const bounds = button.getBoundingClientRect();
    this.popup.hidden = false;
    if (button === this.generatorButton) {
      this.popup.style.left = `${Math.round(Math.min(bounds.right, window.innerWidth - this.popup.offsetWidth - 4))}px`;
      this.popup.style.top = `${Math.round(Math.max(4, Math.min(bounds.top, window.innerHeight - this.popup.offsetHeight - 4)))}px`;
    } else {
      this.popup.style.left = `${Math.round(Math.min(bounds.left, window.innerWidth - this.popup.offsetWidth - 4))}px`;
      this.popup.style.top = `${Math.round(bounds.bottom)}px`;
    }
    if (focusFirst) this.popup.querySelector<HTMLButtonElement>('.app-menu-item:not(:disabled)')?.focus();
  }

  private close(): void {
    window.clearTimeout(this.submenuTimer);
    this.activeButton?.setAttribute('aria-expanded', 'false');
    this.activeButton = null;
    this.popup.hidden = true;
    this.popup.replaceChildren();
  }
}
