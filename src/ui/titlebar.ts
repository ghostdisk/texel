export class TitleBar {
  constructor(private readonly report: (error: unknown) => void) {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-menu]')];
    for (const [index, button] of buttons.entries()) {
      button.onclick = () => void this.open(button);
      button.onkeydown = (event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          buttons[(index + buttons.length + (event.key === 'ArrowRight' ? 1 : -1)) % buttons.length].focus();
        } else if (event.key === 'ArrowDown') { event.preventDefault(); void this.open(button); }
        else if (event.key === 'Escape') button.blur();
        if ([' ', 'Enter', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) event.stopPropagation();
      };
    }
    window.addEventListener('keydown', (event) => {
      if (document.querySelector('dialog[open], [popover]:popover-open')) return;
      if (event.key === 'F10' && !event.shiftKey) { event.preventDefault(); buttons[0]?.focus(); }
      const target = event.altKey && !event.ctrlKey && !event.metaKey ?
        buttons.find((button) => button.dataset.mnemonic === event.key.toLowerCase()) : null;
      if (target) { event.preventDefault(); target.focus(); void this.open(target); }
    });
    const focus = () => document.body.classList.toggle('window-inactive', !document.hasFocus());
    window.addEventListener('focus', focus);
    window.addEventListener('blur', focus);
    focus();
  }

  private async open(button: HTMLButtonElement): Promise<void> {
    if (button.getAttribute('aria-expanded') === 'true') return;
    button.setAttribute('aria-expanded', 'true');
    const bounds = button.getBoundingClientRect();
    try { await window.desktop.openMenu(button.dataset.menu!, Math.round(bounds.left), Math.round(bounds.bottom)); }
    catch (error) { this.report(error); }
    finally { button.setAttribute('aria-expanded', 'false'); }
  }
}
