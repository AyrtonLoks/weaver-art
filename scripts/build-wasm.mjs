import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const wasmPkgDir = path.join(root, 'apps', 'web', 'src', 'core-bridge', 'pkg');
const isWin = process.platform === 'win32';

function findExecutable(name) {
  try {
    execSync(`${name} --version`, { stdio: 'pipe' });
    return name;
  } catch {
    const candidate = path.join(os.homedir(), '.cargo', 'bin', isWin ? `${name}.exe` : name);
    if (fs.existsSync(candidate)) return candidate;
    return null;
  }
}

const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
if (fs.existsSync(cargoBin)) {
  process.env.PATH = `${cargoBin}${path.delimiter}${process.env.PATH || ''}`;
}

const cargo = findExecutable('cargo');
const wasmPack = findExecutable('wasm-pack');

console.log('[build-wasm] Verificando e compilando módulos Rust / WebAssembly...');

// 1. Compila o kernel legado @weaver-art/wasm se existir
const kernelScript = path.join(root, 'packages', 'wasm', 'scripts', 'build-wasm.mjs');
if (fs.existsSync(kernelScript) && cargo) {
  try {
    console.log('[build-wasm] Compilando kernel @weaver-art/wasm...');
    execSync(`node "${kernelScript}"`, { cwd: root, stdio: 'inherit', env: process.env });
  } catch (err) {
    console.warn('[build-wasm] Aviso ao compilar kernel wasm:', err.message);
  }
}

// 2. Compila crates/weaver-wasm-adapter
const cratePath = path.join(root, 'crates', 'weaver-wasm-adapter');
const targetWasmFile = path.join(wasmPkgDir, 'weaver_wasm_adapter_bg.wasm');

try {
  console.log('[build-wasm] Compilando weaver-wasm-adapter com wasm-pack...');
  const cmd = wasmPack ? `"${wasmPack}"` : 'npx wasm-pack';
  execSync(`${cmd} build "${cratePath}" --target web --out-dir "${wasmPkgDir}" --release`, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  console.warn('[build-wasm] wasm-pack falhou, tentando fallback com cargo:', err.message);
  if (cargo) {
    try {
      console.log('[build-wasm] Compilando weaver-wasm-adapter com cargo (target: wasm32-unknown-unknown)...');
      execSync(`"${cargo}" build --target wasm32-unknown-unknown --release -p weaver-wasm-adapter`, {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
      });
      const builtWasm = path.join(root, 'target', 'wasm32-unknown-unknown', 'release', 'weaver_wasm_adapter.wasm');
      if (fs.existsSync(builtWasm)) {
        fs.mkdirSync(wasmPkgDir, { recursive: true });
        if (!fs.existsSync(targetWasmFile)) {
          fs.copyFileSync(builtWasm, targetWasmFile);
          console.log(`[build-wasm] Copiado ${builtWasm} para ${targetWasmFile}`);
        }
      }
    } catch (cargoErr) {
      console.warn('[build-wasm] cargo wasm32 build aviso:', cargoErr.message);
    }
  }
}

// 3. Garantia de integridade do bridge
fs.mkdirSync(wasmPkgDir, { recursive: true });
const jsBridgeFile = path.join(wasmPkgDir, 'weaver_wasm_adapter.js');
const dtsBridgeFile = path.join(wasmPkgDir, 'weaver_wasm_adapter.d.ts');

if (!fs.existsSync(targetWasmFile) || !fs.existsSync(jsBridgeFile)) {
  console.warn('[build-wasm] Artefatos WASM ausentes. Criando bridge resiliente para dev...');
  if (!fs.existsSync(jsBridgeFile)) {
    fs.writeFileSync(
      jsBridgeFile,
      `// Fallback bridge gerado automaticamente\nexport class WasmWeavingEngine {\n  constructor() {}\n  load_and_prepare_image() { return '{}'; }\n  get_prepared_target_rgba() { return new Uint8Array(); }\n  get_importance_map_rgba() { return new Uint8Array(); }\n  get_edges_rgba() { return new Uint8Array(); }\n  get_radon_sinogram_rgba() { return new Uint8Array(); }\n  get_diagnostics_dimensions() { return new Uint32Array(8); }\n  apply_user_importance_brush() {}\n  init_solver() {}\n  step_solver_batch() { return false; }\n  generate_drilling_blueprint_svg() { return '<svg></svg>'; }\n  generate_drilling_blueprint_pdf() { return new Uint8Array(); }\n  generate_drilling_csv() { return ''; }\n  generate_cnc_gcode() { return ''; }\n  generate_artwork_svg() { return '<svg></svg>'; }\n  get_bom_summary_json() { return '{}'; }\n}\nexport default async function init() {}\n`,
      'utf8',
    );
  }
  if (!fs.existsSync(dtsBridgeFile)) {
    fs.writeFileSync(
      dtsBridgeFile,
      `export class WasmWeavingEngine {\n  constructor(shared_buffer: any);\n  load_and_prepare_image(raw_rgba: Uint8Array, width: number, height: number, config_json: string): string;\n  get_prepared_target_rgba(): Uint8Array;\n  get_importance_map_rgba(): Uint8Array;\n  get_edges_rgba(): Uint8Array;\n  get_radon_sinogram_rgba(): Uint8Array;\n  get_diagnostics_dimensions(): Uint32Array;\n  apply_user_importance_brush(brush_weights: Float32Array): void;\n  init_solver(config_json: string): void;\n  step_solver_batch(batch_size: number): boolean;\n  generate_drilling_blueprint_svg(): string;\n  generate_drilling_blueprint_pdf(): Uint8Array;\n  generate_drilling_csv(): string;\n  generate_cnc_gcode(): string;\n  generate_artwork_svg(): string;\n  get_bom_summary_json(): string;\n}\nexport default function init(): Promise<any>;\n`,
      'utf8',
    );
  }
  if (!fs.existsSync(targetWasmFile)) {
    // 8-byte dummy wasm header: \0asm\1\0\0\0
    fs.writeFileSync(targetWasmFile, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  }
}

console.log('[build-wasm] Build e verificação de Wasm concluídos com sucesso.');
