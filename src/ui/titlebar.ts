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

export class TitleBar {
  private readonly buttons: HTMLButtonElement[];
  private readonly popup = document.createElement('div');
  private activeButton: HTMLButtonElement | null = null;
  private switchTimer = 0;
  private submenuTimer = 0;

  constructor(private readonly actions: ActionRegistry) {
    this.buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-menu]')];
    this.popup.className = 'app-menu-popup';
    this.popup.setAttribute('role', 'menu');
    this.popup.hidden = true;
    document.querySelector('.titlebar')?.append(this.popup);
    for (const [index, button] of this.buttons.entries()) {
      button.onclick = () => this.toggle(button);
      button.onpointerenter = () => {
        if (!this.activeButton || this.activeButton === button) return;
        window.clearTimeout(this.switchTimer);
        this.switchTimer = window.setTimeout(() => this.open(button), 120);
      };
      button.onpointerleave = () => window.clearTimeout(this.switchTimer);
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
    document.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (target instanceof Node && (this.popup.contains(target) || this.buttons.some((button) => button.contains(target)))) return;
      this.close();
    });
    window.addEventListener('keydown', (event) => {
      if (document.querySelector('dialog[open], [popover]:popover-open')) return;
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
    label.textContent = action.label;
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
        this.renderRows(submenu, this.rows(row.actions));
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
    window.clearTimeout(this.switchTimer);
    window.clearTimeout(this.submenuTimer);
    this.activeButton?.setAttribute('aria-expanded', 'false');
    this.activeButton = button;
    button.setAttribute('aria-expanded', 'true');
    const menu = this.actions.menus().find((candidate) => candidate.label === button.dataset.menu);
    this.popup.replaceChildren();
    if (menu) this.renderRows(this.popup, this.rows(menu.items));
    const bounds = button.getBoundingClientRect();
    this.popup.style.left = `${Math.round(bounds.left)}px`;
    this.popup.style.top = `${Math.round(bounds.bottom)}px`;
    this.popup.hidden = false;
    if (focusFirst) this.popup.querySelector<HTMLButtonElement>('.app-menu-item:not(:disabled)')?.focus();
  }

  private close(): void {
    window.clearTimeout(this.switchTimer);
    window.clearTimeout(this.submenuTimer);
    this.activeButton?.setAttribute('aria-expanded', 'false');
    this.activeButton = null;
    this.popup.hidden = true;
    this.popup.replaceChildren();
  }
}
