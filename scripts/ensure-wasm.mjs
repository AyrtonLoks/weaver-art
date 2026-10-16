import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const wasmFile = path.join(root, 'apps', 'web', 'src', 'core-bridge', 'pkg', 'weaver_wasm_adapter_bg.wasm');

if (!fs.existsSync(wasmFile)) {
  console.log('[ensure-wasm] Artefato WASM ausente. Executando build...');
  execSync('node scripts/build-wasm.mjs', { cwd: root, stdio: 'inherit' });
}
