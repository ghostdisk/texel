const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const API = 'https://openrouter.ai/api/v1';

function registerOpenRouter({ app, ipcMain, safeStorage }, ownerOf) {
  const jobs = new Map();

  function keyPath() { return path.join(app.getPath('userData'), 'openrouter-key.bin'); }
  function modelCachePath() { return path.join(app.getPath('userData'), 'openrouter-model-catalog.json'); }

  async function readKey() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(await readFile(keyPath()));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('Unable to read OpenRouter key:', error);
      return '';
    }
  }

  async function writeKey(key) {
    if (!key) { await rm(keyPath(), { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    await mkdir(path.dirname(keyPath()), { recursive: true });
    await writeFile(keyPath(), safeStorage.encryptString(key));
  }

  async function readModelCache() {
    try { return JSON.parse(await readFile(modelCachePath(), 'utf8')); }
    catch (error) {
      if (error?.code !== 'ENOENT') console.error('Unable to read OpenRouter model cache:', error);
      return null;
    }
  }

  async function writeModelCache(value) {
    try {
      await mkdir(path.dirname(modelCachePath()), { recursive: true });
      await writeFile(modelCachePath(), JSON.stringify(value));
    } catch (error) { console.error('Unable to write OpenRouter model cache:', error); }
  }

  async function errorMessage(response) {
    const text = await response.text();
    try { return JSON.parse(text)?.error?.message || text || `OpenRouter request failed (${response.status}).`; }
    catch { return text || `OpenRouter request failed (${response.status}).`; }
  }

  async function request(pathname, options = {}) {
    const key = await readKey();
    const headers = { 'Content-Type': 'application/json', 'X-Title': 'Texel', ...options.headers };
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(API + pathname, { ...options, headers });
    if (!response.ok) throw new Error(await errorMessage(response));
    return response;
  }

  ipcMain.handle('openrouter:key-status', (event) => ownerOf(event) ? readKey().then((key) => ({ configured: !!key })) : null);
  ipcMain.handle('openrouter:set-key', async (event, value) => {
    if (!ownerOf(event) || typeof value !== 'string' || value.length > 512) return null;
    const key = value.trim();
    if (key && !key.startsWith('sk-or-')) throw new Error('Enter a valid OpenRouter API key.');
    await writeKey(key);
    return { configured: !!key };
  });
  ipcMain.handle('openrouter:models', async (event) => {
    if (!ownerOf(event)) return null;
    try {
      const models = await request('/images/models').then((response) => response.json());
      await writeModelCache(models);
      return models;
    } catch (error) {
      const cached = await readModelCache();
      if (cached?.data) return cached;
      throw error;
    }
  });
  ipcMain.handle('openrouter:cancel', (event, id) => {
    const owner = ownerOf(event);
    const job = typeof id === 'string' ? jobs.get(id) : null;
    if (!owner || !job || job.sender !== event.sender) return false;
    job.controller.abort();
    return true;
  });
  ipcMain.handle('openrouter:generate', async (event, generation) => {
    const owner = ownerOf(event);
    if (!owner || !generation || typeof generation !== 'object') throw new Error('Invalid OpenRouter generation request.');
    const { id, model, prompt, width, height, input, seed, stream } = generation;
    if (typeof id !== 'string' || !id || jobs.has(id) || typeof model !== 'string' ||
        !/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(model) || typeof prompt !== 'string' ||
        !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error('Invalid OpenRouter generation request.');
    }
    const key = await readKey();
    if (!key) throw new Error('Add an OpenRouter API key in Settings before generating.');
    const body = { model, prompt, size: `${width}x${height}`, output_format: 'png', stream: !!stream };
    if (input instanceof Uint8Array && input.byteLength) {
      body.input_references = [{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(input).toString('base64')}` } }];
    }
    if (Number.isInteger(seed) && seed >= 0) body.seed = seed;
    const controller = new AbortController();
    jobs.set(id, { controller, sender: event.sender });
    try {
      const response = await request('/images', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (!body.stream) {
        const result = await response.json();
        const image = result.data?.[0];
        if (!image?.b64_json) throw new Error('OpenRouter returned no image.');
        return { bytes: new Uint8Array(Buffer.from(image.b64_json, 'base64')), mediaType: image.media_type || 'image/png', cost: result.usage?.cost };
      }
      if (!response.body) throw new Error('OpenRouter returned an empty image stream.');
      const decoder = new TextDecoder();
      let pending = '';
      let completed = null;
      const handle = (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const message = JSON.parse(data);
        if (message.type === 'image_generation.partial_image' && message.b64_json) {
          if (!owner.isDestroyed()) owner.webContents.send('openrouter:generation-event', {
            id, type: 'preview', bytes: new Uint8Array(Buffer.from(message.b64_json, 'base64')), mediaType: 'image/png',
          });
        } else if (message.type === 'image_generation.completed' && message.b64_json) completed = message;
        else if (message.type === 'error') throw new Error(message.error?.message || 'OpenRouter generation failed.');
      };
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) handle(line);
      }
      pending += decoder.decode();
      if (pending) handle(pending);
      if (!completed?.b64_json) throw new Error('OpenRouter returned no completed image.');
      return {
        bytes: new Uint8Array(Buffer.from(completed.b64_json, 'base64')),
        mediaType: completed.media_type || 'image/png', cost: completed.usage?.cost,
      };
    } finally { jobs.delete(id); }
  });

  return { stop: () => { for (const job of jobs.values()) job.controller.abort(); jobs.clear(); } };
}

module.exports = { registerOpenRouter };
