export interface Action {
  id: string;
  label: string | (() => string);
  menu?: 'File' | 'Edit' | 'Layer' | 'Filter';
  submenu?: string;
  enabled?: () => boolean;
  execute(): void | Promise<void>;
  release?: () => void;
}

export interface MenuAction {
  id: string;
  label: string;
  enabled: boolean;
  shortcut: string;
  submenu?: string;
}

export interface ActionMenu {
  label: string;
  items: MenuAction[];
}

export function isEditingText(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('textarea, select, [contenteditable="true"]')) return true;
  const input = target.closest('input');
  return !!input && !['range', 'color', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'hidden'].includes(input.type);
}

/** Buttons, menus, and keybindings all dispatch the same named actions. */
export class ActionRegistry {
  private actions = new Map<string, Action>();
  private bindings = new Map<string, string>();
  private held = new Map<string, Action>();
  beforeExecute?: () => void;
  blocked?: () => boolean;

  constructor(private readonly reportError: (error: unknown) => void) {}

  register(action: Action): void {
    if (this.actions.has(action.id)) throw new Error(`Duplicate action: ${action.id}`);
    this.actions.set(action.id, action);
  }

  bind(chord: string, actionId: string): void {
    if (!this.actions.has(actionId)) throw new Error(`Unknown action: ${actionId}`);
    this.bindings.set(chord.toLowerCase(), actionId);
  }

  enabled(id: string): boolean { const action = this.actions.get(id); return !this.blocked?.() && !!action && (action.enabled?.() ?? true); }

  execute(id: string): void {
    const action = this.actions.get(id);
    if (!action || this.blocked?.()) return;
    try {
      if (!action.release) this.beforeExecute?.();
      if (!(action.enabled?.() ?? true)) return;
      void Promise.resolve(action.execute()).catch(this.reportError);
    } catch (error) { this.reportError(error); }
  }

  menus(): ActionMenu[] {
    return ['File', 'Edit', 'Layer', 'Filter'].map((label) => ({ label, items: [...this.actions.values()]
      .filter((action) => action.menu === label)
      .map((action) => ({
        id: action.id,
        label: typeof action.label === 'function' ? action.label() : action.label,
        enabled: this.enabled(action.id),
        submenu: action.submenu,
        shortcut: [...this.bindings].find(([, id]) => id === action.id)?.[0] ?? '',
      })),
    }));
  }

  attach(): () => void {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || isEditingText(event.target) || document.querySelector('dialog[open]') || document.getElementById('app')?.inert) return;
      const key = event.code.replace(/^Key/, '').replace(/^Digit/, '');
      const chord = event.code.startsWith('Alt') ? 'alt' : [event.ctrlKey || event.metaKey ? 'ctrl' : '', event.altKey ? 'alt' : '', event.shiftKey ? 'shift' : '', key.toLowerCase()].filter(Boolean).join('+');
      const id = this.bindings.get(chord) ?? (event.code === 'Space' && !event.ctrlKey && !event.metaKey ? this.bindings.get('space') : undefined);
      if (!id) return;
      event.preventDefault();
      if (event.repeat) return;
      const action = this.actions.get(id)!;
      if (action.release && !this.enabled(id)) return;
      if (action.release) this.held.set(event.code, action);
      this.execute(id);
    };
    const keyup = (event: KeyboardEvent) => {
      const action = this.held.get(event.code);
      if (!action) return;
      event.preventDefault();
      this.held.delete(event.code);
      if (![...this.held.values()].includes(action)) action.release?.();
    };
    const releaseAll = () => { for (const action of this.held.values()) action.release?.(); this.held.clear(); };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', releaseAll);
    return () => {
      releaseAll();
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', releaseAll);
    };
  }
}
