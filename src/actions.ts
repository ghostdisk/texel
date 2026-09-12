export type ActionMenuName = 'File' | 'Edit' | 'Select' | 'Layer' | 'Filter' | 'Tools' | 'View';

export interface Action {
  id: string;
  label: string | (() => string);
  menu: ActionMenuName;
  submenu?: string;
  enabled?: () => boolean;
  execute(): void | Promise<void>;
  hold?: {
    press(): void;
    release(): void;
  };
}

export interface MenuAction {
  id: string;
  label: string;
  enabled: boolean;
  shortcut: string;
  submenu?: string;
}

export interface ActionMenu {
  label: ActionMenuName;
  items: MenuAction[];
}

export interface KeybindingOptions {
  when?: string;
  hold?: boolean;
}

type ActionContext = Readonly<Record<string, boolean>>;
type Condition = (context: ActionContext) => boolean;

interface Keybinding extends KeybindingOptions {
  actionId: string;
  condition: Condition;
}

/** Compile boolean context expressions without evaluating JavaScript. */
function compileCondition(expression?: string): Condition {
  if (expression === undefined) return () => true;
  const tokens = expression.match(/&&|\|\||[!()]|[a-zA-Z_]\w*|\S/g) ?? [];
  let position = 0;
  const invalid = () => new Error(`Invalid keybinding condition: ${expression}`);
  const primary = (): Condition => {
    const token = tokens[position++];
    if (token === '!') { const operand = primary(); return (context) => !operand(context); }
    if (token === '(') {
      const nested = or();
      if (tokens[position++] !== ')') throw invalid();
      return nested;
    }
    if (!token || !/^[a-zA-Z_]\w*$/.test(token)) throw invalid();
    if (token === 'true' || token === 'false') return () => token === 'true';
    return (context) => Object.hasOwn(context, token) && context[token] === true;
  };
  const and = (): Condition => {
    let condition = primary();
    while (tokens[position] === '&&') {
      position++;
      const left = condition, right = primary();
      condition = (context) => left(context) && right(context);
    }
    return condition;
  };
  const or = (): Condition => {
    let condition = and();
    while (tokens[position] === '||') {
      position++;
      const left = condition, right = and();
      condition = (context) => left(context) || right(context);
    }
    return condition;
  };
  const condition = or();
  if (position !== tokens.length) throw invalid();
  return condition;
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
  private bindings = new Map<string, Keybinding[]>();
  private held = new Map<string, Action>();
  beforeExecute?: () => void;
  blocked?: () => boolean;
  context?: () => ActionContext;

  constructor(private readonly reportError: (error: unknown) => void) {}

  register(action: Action): void {
    if (this.actions.has(action.id)) throw new Error(`Duplicate action: ${action.id}`);
    this.actions.set(action.id, action);
  }

  bind(chord: string, actionId: string, options: KeybindingOptions = {}): void {
    const action = this.actions.get(actionId);
    if (!action) throw new Error(`Unknown action: ${actionId}`);
    if (options.hold && !action.hold) throw new Error(`Action cannot be held: ${actionId}`);
    const key = chord.toLowerCase();
    const bindings = this.bindings.get(key) ?? [];
    bindings.push({ ...options, actionId, condition: compileCondition(options.when) });
    this.bindings.set(key, bindings);
  }

  private binding(chord: string, context: ActionContext): Keybinding | undefined {
    const bindings = this.bindings.get(chord) ?? [];
    for (let index = bindings.length - 1; index >= 0; index--) {
      if (bindings[index].condition(context)) return bindings[index];
    }
    return undefined;
  }

  enabled(id: string): boolean { const action = this.actions.get(id); return !this.blocked?.() && !!action && (action.enabled?.() ?? true); }

  execute(id: string): void {
    const action = this.actions.get(id);
    if (!action || this.blocked?.()) return;
    try {
      this.beforeExecute?.();
      if (!(action.enabled?.() ?? true)) return;
      void Promise.resolve(action.execute()).catch(this.reportError);
    } catch (error) { this.reportError(error); }
  }

  menus(): ActionMenu[] {
    const context = this.context?.() ?? {};
    const shortcuts = new Map<string, string>();
    for (const chord of this.bindings.keys()) {
      const binding = this.binding(chord, context);
      if (binding && !shortcuts.has(binding.actionId)) shortcuts.set(binding.actionId, chord);
    }
    const menus: ActionMenuName[] = ['File', 'Edit', 'Select', 'Layer', 'Filter', 'Tools', 'View'];
    return menus.map((label) => ({ label, items: [...this.actions.values()]
      .filter((action) => action.menu === label)
      .map((action) => ({
        id: action.id,
        label: typeof action.label === 'function' ? action.label() : action.label,
        enabled: this.enabled(action.id),
        submenu: action.submenu,
        shortcut: shortcuts.get(action.id) ?? '',
      })),
    }));
  }

  attach(): () => void {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || isEditingText(event.target) || document.querySelector('dialog[open], [popover]:popover-open') ||
          document.getElementById('app')?.inert) return;
      const key = event.code.replace(/^Key/, '').replace(/^Digit/, '');
      const chord = event.code.startsWith('Alt') ? 'alt' : [event.ctrlKey || event.metaKey ? 'ctrl' : '', event.altKey ? 'alt' : '', event.shiftKey ? 'shift' : '', key.toLowerCase()].filter(Boolean).join('+');
      const context = this.context?.() ?? {};
      const binding = this.binding(chord, context) ??
        (event.code === 'Space' && !event.ctrlKey && !event.metaKey ? this.binding('space', context) : undefined);
      if (!binding) return;
      event.preventDefault();
      if (event.repeat) return;
      const action = this.actions.get(binding.actionId)!;
      if (binding.hold) {
        if (!this.enabled(action.id) || this.held.has(event.code)) return;
        this.held.set(event.code, action);
        try { action.hold!.press(); }
        catch (error) { this.held.delete(event.code); this.reportError(error); }
      } else this.execute(action.id);
    };
    const keyup = (event: KeyboardEvent) => {
      const action = this.held.get(event.code);
      if (!action) return;
      event.preventDefault();
      this.held.delete(event.code);
      if (![...this.held.values()].includes(action)) action.hold?.release();
    };
    const releaseAll = () => { for (const action of new Set(this.held.values())) action.hold?.release(); this.held.clear(); };
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
