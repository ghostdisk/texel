export interface TabDefinition {
  id: string;
  label: string;
  panel: HTMLElement;
}

/** A tab group owns navigation and visibility; panels own their content and state. */
export class TabGroup {
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private activeId: string;

  constructor(host: HTMLElement, private readonly tabs: readonly TabDefinition[], label: string) {
    if (!tabs.length || new Set(tabs.map((tab) => tab.id)).size !== tabs.length) throw new Error('Tabs require unique IDs.');
    this.activeId = tabs[0].id;
    host.classList.add('tab-group');
    const strip = document.createElement('div');
    strip.className = 'tab-strip';
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', label);
    const prefix = 'tabs-' + crypto.randomUUID();
    for (const tab of tabs) {
      const button = document.createElement('button');
      button.className = 'tab';
      button.id = `${prefix}-${tab.id}`;
      button.textContent = tab.label;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', tab.panel.id ||= `${button.id}-panel`);
      tab.panel.setAttribute('role', 'tabpanel');
      tab.panel.setAttribute('aria-labelledby', button.id);
      tab.panel.classList.add('tab-panel');
      button.onclick = () => this.select(tab.id);
      button.onkeydown = (event) => {
        const index = tabs.findIndex((item) => item.id === tab.id);
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        event.stopPropagation();
        this.select(tabs[next].id, true);
      };
      this.buttons.set(tab.id, button);
      strip.append(button);
    }
    host.append(strip, ...tabs.map((tab) => tab.panel));
    this.select(this.activeId);
  }

  select(id: string, focus = false): void {
    if (!this.buttons.has(id)) return;
    this.activeId = id;
    for (const tab of this.tabs) {
      const active = tab.id === id;
      const button = this.buttons.get(tab.id)!;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      tab.panel.hidden = !active;
    }
    if (focus) this.buttons.get(id)!.focus();
  }
}
