import { element } from './editor-view';

export class AboutView {
  private readonly dialog = element<HTMLDialogElement>('about-dialog');

  constructor() {
    element<HTMLButtonElement>('close-about').addEventListener('click', () => this.dialog.close());
  }

  async open(): Promise<void> {
    const info = await window.desktop.appInfo();
    if (!info) return;
    element('about-name').textContent = info.name;
    element('about-version').textContent = `Version ${info.version}`;
    element('about-license').textContent = `${info.license} License`;
    this.dialog.showModal();
  }
}
