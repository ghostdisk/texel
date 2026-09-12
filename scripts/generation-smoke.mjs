import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const token = randomBytes(32).toString('hex');
const preset = process.env.IMGED_NATIVE_PRESET ?? 'clang-vulkan';
const binary = process.env.IMGED_NATIVE_BINARY ?? path.join(root, 'native/build', preset, 'bin', process.platform === 'win32' ? 'imged-native.exe' : 'imged-native');
const child = spawn(binary, [], {
  cwd: root, windowsHide: true, env: { ...process.env, IMGED_BACKEND_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (data) => { stderr += data; process.stderr.write(data); });
child.stdin.on('error', () => {});
const ready = await new Promise((resolve, reject) => {
  createInterface({ input: child.stdout }).on('line', (line) => {
    try { const item = JSON.parse(line); if (item.type === 'ready') resolve(item); } catch {}
  });
  child.on('error', reject);
  child.on('exit', (code) => reject(new Error('Native exited: ' + code + '\n' + stderr.slice(-2000))));
});
const socket = new WebSocket('ws://127.0.0.1:' + ready.port);
socket.binaryType = 'arraybuffer';
const width = Number(process.env.IMGED_SMOKE_WIDTH ?? 512), height = Number(process.env.IMGED_SMOKE_HEIGHT ?? 512);
const strength = Number(process.env.IMGED_SMOKE_STRENGTH ?? 1);
let previews = 0, stage = 'first', done;
const completed = new Promise((resolve, reject) => { done = { resolve, reject }; });
const timer = setTimeout(() => done.reject(new Error('Generation smoke test timed out.')), 900000);
function generate(id, steps, mask = false) {
  const input = new Uint8Array(width * height * 4).fill(255);
  const selection = mask ? new Uint8Array(input.length) : new Uint8Array();
  for (let y = 0; mask && y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    selection.fill(x >= width / 2 ? 255 : 0, offset, offset + 4);
  }
  const header = new TextEncoder().encode(JSON.stringify({
    type: 'generate', id, model: 'local/miaomiaoHarem_anima16', width, height,
    prompt: 'a small red ceramic teapot on a white table, soft studio lighting', steps, seed: 42, guidance: 3.5, strength,
    inputBytes: input.length, maskBytes: selection.length,
  }));
  const packet = new Uint8Array(4 + header.length + input.length + selection.length);
  new DataView(packet.buffer).setUint32(0, header.length, true);
  packet.set(header, 4); packet.set(input, 4 + header.length); packet.set(selection, 4 + header.length + input.length);
  socket.send(packet);
}
socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token }));
socket.onerror = () => done.reject(new Error('WebSocket failed.'));
socket.onmessage = async ({ data }) => {
  try {
    let message, png;
    if (typeof data === 'string') message = JSON.parse(data);
    else {
      const length = new DataView(data).getUint32(0, true);
      message = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, length)));
      png = new Uint8Array(data, 4 + length);
    }
    console.log(JSON.stringify(message));
    if (message.type === 'progress' && message.steps && (message.step < 0 || message.step > message.steps)) throw new Error('Invalid step progress.');
    if (message.type === 'models') generate('smoke-result', 4);
    if (message.type === 'preview') {
      previews++;
      if (stage === 'cancel') { stage = 'cancelling'; socket.send(JSON.stringify({ type: 'cancel', id: 'smoke-cancel' })); }
    }
    if (message.type === 'result') {
      if (message.width !== width || message.height !== height || !png || png[0] !== 137) throw new Error('Invalid generated PNG.');
      const pngHeader = new DataView(png.buffer, png.byteOffset, png.byteLength);
      if (pngHeader.getUint32(16) !== width || pngHeader.getUint32(20) !== height) throw new Error('PNG dimensions differ from requested size.');
      await mkdir(path.join(root, 'native/build'), { recursive: true });
      await writeFile(path.join(root, 'native/build/smoke-result.png'), png);
      if (!previews) throw new Error('No live previews were emitted.');
      stage = 'cancel';
      setTimeout(() => generate('smoke-cancel', 30, true), 100);
    }
    if (message.type === 'cancelled') done.resolve();
    if (message.type === 'error') throw new Error(message.message);
  } catch (error) { done.reject(error); }
};
try { await completed; console.log('PASS: model discovery, ' + width + 'x' + height + ' generation, previews, masked request, cancellation'); }
finally { clearTimeout(timer); socket.close(); child.stdin.end('shutdown\n'); setTimeout(() => child.kill(), 4000).unref(); }
