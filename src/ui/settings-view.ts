import type { PackageManifest, PackageSettingField, PackageSettingGroup } from '../package-runtime';
import type { SettingsStore } from '../settings';
import { THEMES } from '../themes';

export class SettingsView {
  private readonly dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
  private readonly grid = document.querySelector<HTMLElement>('#theme-grid')!;
  private readonly recentFiles = document.querySelector<HTMLInputElement>('#remember-recent-files')!;
  private readonly canvasBackground = document.querySelector<HTMLInputElement>('#canvas-background')!;
  private readonly resetCanvasBackground = document.querySelector<HTMLButtonElement>('#reset-canvas-background')!;
  private readonly packageList = document.querySelector<HTMLElement>('#package-settings-list')!;

  constructor(private readonly settings: SettingsStore) {
    document.querySelector<HTMLButtonElement>('#close-settings')!.onclick = () => this.dialog.close();
    this.recentFiles.onchange = () => settings.setRememberRecentFiles(this.recentFiles.checked);
    this.canvasBackground.onchange = () => settings.setCanvasBackground(this.canvasBackground.value);
    this.resetCanvasBackground.onclick = () => settings.setCanvasBackground(null);
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-settings-page]')) {
      button.onclick = () => this.showPage(button.dataset.settingsPage!);
    }
    this.renderThemes();
    settings.subscribe(() => { this.syncGeneral(); this.syncAppearance(); });
  }

  open(): void {
    this.syncGeneral();
    this.syncAppearance();
    void this.renderPackages();
    this.dialog.showModal();
  }

  openCanvasBackground(): void {
    this.showPage('appearance');
    this.open();
    this.canvasBackground.focus();
  }

  private showPage(page: string): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-settings-page]')) {
      const selected = button.dataset.settingsPage === page;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', String(selected));
    }
    for (const panel of document.querySelectorAll<HTMLElement>('[data-settings-panel]')) {
      panel.hidden = panel.dataset.settingsPanel !== page;
    }
  }

  private renderThemes(): void {
    for (const theme of THEMES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `theme-card ${theme.className}`;
      card.dataset.theme = theme.id;
      card.innerHTML = `
        <span class="theme-preview" aria-hidden="true">
          <span class="theme-preview-titlebar"></span>
          <span class="theme-preview-sidebar"><i></i><i></i><i></i></span>
          <span class="theme-preview-workspace"><i></i><i></i></span>
        </span>
        <span class="theme-card-copy"><strong>${theme.name}</strong><small>${theme.family}</small></span>`;
      card.onclick = () => this.settings.setTheme(theme.id);
      this.grid.append(card);
    }
    this.syncAppearance();
  }

  private syncGeneral(): void { this.recentFiles.checked = this.settings.rememberRecentFiles; }

  private syncAppearance(): void {
    this.canvasBackground.value = this.settings.canvasBackground;
    this.resetCanvasBackground.disabled = this.settings.customCanvasBackground === null;
    for (const card of this.grid.querySelectorAll<HTMLButtonElement>('.theme-card')) {
      const selected = card.dataset.theme === this.settings.theme;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
    }
  }

  private async renderPackages(): Promise<void> {
    try {
      const [packages, settings] = await Promise.all([window.desktop.listPackages(), window.desktop.packageSettings()]);
      const settingsByPackage = new Map(settings.map((group) => [group.packageName, group]));
      this.packageList.replaceChildren(...packages.map((manifest) => this.packageCard(manifest, settingsByPackage.get(manifest.name))));
    } catch (error) {
      const message = document.createElement('p');
      message.className = 'package-settings-error';
      message.textContent = error instanceof Error ? error.message : String(error);
      this.packageList.replaceChildren(message);
    }
  }

  private packageCard(manifest: PackageManifest, group?: PackageSettingGroup): HTMLElement {
    const card = document.createElement('section');
    card.className = 'package-settings-card';
    const heading = document.createElement('div');
    heading.className = 'package-settings-heading';
    const title = document.createElement('div');
    const name = document.createElement('h4');
    name.textContent = manifest.displayName;
    const id = document.createElement('small');
    id.textContent = `${manifest.name} · ${manifest.version}`;
    title.append(name, id);
    const state = document.createElement('span');
    state.textContent = 'Installed';
    heading.append(title, state);
    card.append(heading);
    if (manifest.description) {
      const description = document.createElement('p');
      description.textContent = manifest.description;
      card.append(description);
    }
    if (group?.fields.length) for (const field of group.fields) card.append(this.settingRow(group.packageName, field));
    else {
      const empty = document.createElement('p');
      empty.className = 'package-settings-empty';
      empty.textContent = manifest.dependencies.length ? `Depends on ${manifest.dependencies.join(', ')}` : 'No settings';
      card.append(empty);
    }
    return card;
  }

  private settingRow(packageName: string, field: PackageSettingField): HTMLElement {
    const row = document.createElement('div');
    row.className = 'package-setting';
    const copy = document.createElement('label');
    copy.textContent = field.label;
    if (field.description) {
      const description = document.createElement('small');
      description.textContent = field.description;
      copy.append(description);
    }
    const input = document.createElement('input');
    input.type = field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : field.type === 'boolean' ? 'checkbox' : 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = field.type === 'secret' && field.configured ? 'Stored securely' : field.placeholder;
    if (field.type === 'boolean') input.checked = field.value === true;
    else if (field.value !== undefined) input.value = String(field.value);
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.hidden = field.type !== 'secret';
    remove.disabled = !field.configured;
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    status.textContent = field.type === 'secret' ? field.configured ? 'Configured' : 'Not configured' : '';
    const saveValue = async (value: unknown) => {
      try {
        const result = await window.desktop.setPackageSetting(packageName, field.key, value) as { configured?: boolean } | null;
        if (field.type === 'secret') {
          input.value = '';
          const configured = !!result?.configured;
          status.textContent = configured ? 'Configured' : 'Not configured';
          input.placeholder = configured ? 'Stored securely' : field.placeholder;
          remove.disabled = !configured;
        } else status.textContent = 'Saved';
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    };
    save.onclick = () => void saveValue(field.type === 'boolean' ? input.checked : input.value);
    remove.onclick = () => void saveValue('');
    row.append(copy, input, save, remove, status);
    return row;
  }
}
