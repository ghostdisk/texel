import { Gpu } from './gpu/device';
import { Editor } from './editor';
import { EditorView, element } from './ui/editor-view';
import { hydrateIcons } from './ui/icons';
import { TitleBar } from './ui/titlebar';
import { SettingsStore } from './settings';
import { SettingsView } from './ui/settings-view';

function reportError(error: unknown): void {
  const banner = element('error');
  banner.textContent = error instanceof Error ? error.message : String(error);
  banner.hidden = false;
}

async function boot(): Promise<void> {
  const settings = new SettingsStore(reportError);
  await settings.load();
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
  const settingsView = new SettingsView(settings);
  editor.onOpenSettings = () => settingsView.open();
  new TitleBar(editor.actions);
  new EditorView(editor);
  editor.actions.attach();
  window.desktop.onAction((id) => editor!.run(() => editor!.actions.execute(id)));
  editor.resize();
  editor.reset(1000, 750);
  if (!failed) {
    element('app').inert = false;
    editor.files.listenForOpenRequests();
  }
}

hydrateIcons();
void boot().catch(reportError);
