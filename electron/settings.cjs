const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const path = require('node:path');

function registerSettings({ app, ipcMain, nativeTheme }, ownerOf) {
  const defaults = { theme: 'texel' };
  let cached = null;
  let writes = Promise.resolve();

  function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }

  async function load() {
    if (cached) return cached;
    try {
      const parsed = JSON.parse(await readFile(settingsPath(), 'utf8'));
      cached = parsed && typeof parsed === 'object' && typeof parsed.theme === 'string' ? { ...defaults, theme: parsed.theme } : defaults;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('Unable to read settings:', error);
      cached = defaults;
    }
    return cached;
  }

  function persist(settings) {
    const file = settingsPath();
    const temporary = `${file}.${process.pid}.tmp`;
    writes = writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(temporary, JSON.stringify(settings, null, 2), 'utf8');
      await rename(temporary, file);
    });
    return writes;
  }

  ipcMain.handle('settings:get', (event) => ownerOf(event) ? load() : null);
  ipcMain.handle('settings:update', async (event, update) => {
    if (!ownerOf(event) || !update || typeof update !== 'object') return null;
    const current = await load();
    const theme = typeof update.theme === 'string' && /^[a-z0-9-]{1,80}$/.test(update.theme) ? update.theme : current.theme;
    cached = { ...current, theme };
    await persist(cached);
    return cached;
  });
  ipcMain.handle('window:set-theme', (event, theme) => {
    const owner = ownerOf(event);
    if (!owner || !theme || typeof theme !== 'object' || typeof theme.dark !== 'boolean' ||
        typeof theme.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(theme.background)) return;
    nativeTheme.themeSource = theme.dark ? 'dark' : 'light';
    owner.setBackgroundColor(theme.background);
    if (process.platform !== 'darwin') owner.setTitleBarOverlay({
      color: '#00000000', symbolColor: theme.dark ? '#e6e8f5' : '#24292f', height: 35,
    });
  });
}

module.exports = { registerSettings };
