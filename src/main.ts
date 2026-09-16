import { Gpu } from './gpu/device';
import { Editor } from './editor';
import { EditorView, element } from './ui/editor-view';
import { hydrateIcons } from './ui/icons';
import { TitleBar } from './ui/titlebar';
import { SettingsStore } from './settings';
import { SettingsView } from './ui/settings-view';
import { CommandPalette } from './ui/command-palette';
import { RendererPackageLoader } from './package-runtime';
import { AboutView } from './ui/about-view';

function showMessage(text: string, notice = false): void {
  const messages = element('error');
  for (const existing of messages.children) if (existing.textContent === text) existing.remove();
  while (messages.children.length >= 3) messages.firstElementChild?.remove();
  const message = document.createElement('div');
  message.className = `editor-message${notice ? ' editor-notice' : ''}`;
  message.textContent = text;
  messages.append(message);
  const timeout = window.setTimeout(() => message.remove(), 5000);
  message.addEventListener('animationend', () => { clearTimeout(timeout); message.remove(); }, { once: true });
}

function reportError(error: unknown): void { showMessage(error instanceof Error ? error.message : String(error)); }

async function boot(): Promise<void> {
  const setMaximized = (maximized: boolean) => document.documentElement.classList.toggle('window-maximized', maximized);
  window.desktop.onWindowMaximizedChanged(setMaximized);
  setMaximized(await window.desktop.isWindowMaximized());
  const settings = new SettingsStore(reportError);
  await settings.load();
  const packages = new RendererPackageLoader(reportError);
  await packages.load();
  window.addEventListener('beforeunload', () => { void packages.unload(); }, { once: true });
  const gpu = await Gpu.create();
  let editor: Editor | undefined;
  let failed = false;
  const fail = (message: string) => {
    if (failed) return;
    failed = true;
    if (editor) editor.halted = true;
    element('app').inert = true;
    reportError(new Error(message));
  };
  gpu.device.addEventListener('uncapturederror', (event) => fail(`GPU error: ${event.error.message}`));
  void gpu.device.lost.then((info) => fail(`GPU connection lost: ${info.message || info.reason}. Reload to start a new document.`));
  const overlay = document.querySelector<SVGSVGElement>('#tool-overlay');
  if (!overlay) throw new Error('Missing tool overlay.');
  editor = new Editor(
    gpu, element<HTMLCanvasElement>('canvas'), element('stage'), overlay,
    element('brush-cursor'), element('tool-mode-cursor'), reportError,
  );
  editor.onNotify = (message) => showMessage(message, true);
  const applySettings = () => {
    editor?.setCanvasBackground(settings.canvasBackground);
    editor?.files.setRememberRecentFiles(settings.rememberRecentFiles);
  };
  settings.subscribe(applySettings);
  applySettings();
  const settingsView = new SettingsView(settings);
  editor.onOpenSettings = () => settingsView.open();
  editor.onCanvasBackgroundSettings = () => settingsView.openCanvasBackground();
  const aboutView = new AboutView();
  editor.onOpenAbout = () => { void aboutView.open().catch(reportError); };
  const commandPalette = new CommandPalette(editor);
  editor.onCommandPalette = () => commandPalette.open();
  new TitleBar(editor.actions);
  new EditorView(editor);
  editor.actions.attach();
  window.desktop.onAction((id) => editor!.run(() => editor!.actions.execute(id)));
  editor.resize();
  editor.changed();
  if (!failed) {
    element('app').inert = false;
    editor.files.listenForOpenRequests();
  }
}

hydrateIcons();
void boot().catch(reportError);
