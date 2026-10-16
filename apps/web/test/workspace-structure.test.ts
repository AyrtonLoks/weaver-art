import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  commitRingBufferReadIndexAtomically,
  createSharedRingBuffer,
  isCrossOriginIsolatedContext,
  readRingBufferReadIndexAtomically,
  readRingBufferWriteIndexAtomically,
  RING_BUFFER_HEADER_WORDS,
  RING_CONTROL_WRITE_INDEX,
} from '../src/core-bridge/index.js';
import { DEFAULT_OPTIONS, isSliderVisible, PRESETS } from '../src/preset-engine/index.js';
import { detectRendererCapabilities } from '../src/renderer-webgl/index.js';
import viteConfig from '../vite.config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webRoot, '../..');

describe('Task 0.2 — Polyglot Monorepo & COOP/COEP Cross-Origin Isolation', () => {
  it('configures COOP/COEP headers, ES worker format, and .wasm assets in vite.config.ts', () => {
    const config = viteConfig;
    expect(config.server?.headers).toMatchObject({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    expect(config.preview?.headers).toMatchObject({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    expect(config.worker).toMatchObject({
      format: 'es',
    });
    expect(config.assetsInclude).toContain('**/*.wasm');
  });

  it('serves COOP/COEP headers over HTTP from both Vite dev and preview servers and enables window.crossOriginIsolated in Chromium', async () => {
    const devServer = await createServer({
      root: webRoot,
      configFile: path.join(webRoot, 'vite.config.ts'),
      server: { port: 0, host: '127.0.0.1' },
      logLevel: 'silent',
    });
    try {
      await devServer.listen();
      const address = devServer.httpServer?.address();
      expect(address).toBeTruthy();
      const port = typeof address === 'object' && address !== null ? address.port : 5173;
      const url = `http://127.0.0.1:${port}/`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');

      const browserCandidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ];
      const browserBin = browserCandidates.find((p) => fs.existsSync(p));
      if (browserBin) {
        const { spawn } = await import('node:child_process');
        const os = await import('node:os');
        const net = await import('node:net');
        const debugPort = await new Promise<number>((resolve, reject) => {
          const srv = net.createServer();
          srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const p = typeof addr === 'object' && addr ? addr.port : 9229;
            srv.close((err) => (err ? reject(err) : resolve(p)));
          });
        });
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-cdp-'));
        const proc = spawn(browserBin, [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${userDataDir}`,
          `--remote-debugging-port=${debugPort}`,
          url,
        ]);
        try {
          let evalResult: { crossOriginIsolated: boolean; hasSAB: boolean } | null = null;
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 150));
            try {
              const targetsRes = await fetch(`http://127.0.0.1:${debugPort}/json`);
              const targets = (await targetsRes.json()) as Array<{
                type: string;
                url: string;
                webSocketDebuggerUrl?: string;
              }>;
              const page = targets.find((t) => t.type === 'page' && t.url.startsWith(url));
              if (page?.webSocketDebuggerUrl) {
                const ws = new WebSocket(page.webSocketDebuggerUrl);
                await new Promise<void>((resolve, reject) => {
                  ws.onopen = () => resolve();
                  ws.onerror = (e) => reject(e);
                });
                ws.send(
                  JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: {
                      expression:
                        'JSON.stringify({ href: window.location.href, readyState: document.readyState, isSecureContext: window.isSecureContext, crossOriginIsolated: window.crossOriginIsolated === true, hasSAB: typeof window.SharedArrayBuffer === "function" })',
                      returnByValue: true,
                    },
                  }),
                );
                const msg = await new Promise<{ result?: { result?: { value?: string } } }>((resolve) => {
                  ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
                });
                ws.close();
                if (msg.result?.result?.value) {
                  const parsed = JSON.parse(msg.result.result.value) as {
                    href: string;
                    readyState: string;
                    isSecureContext: boolean;
                    crossOriginIsolated: boolean;
                    hasSAB: boolean;
                  };
                  if (parsed.href === url && parsed.readyState === 'complete') {
                    evalResult = {
                      crossOriginIsolated: parsed.crossOriginIsolated,
                      hasSAB: parsed.hasSAB,
                    };
                    break;
                  }
                }
              }
            } catch {
              // Wait for CDP endpoint and page navigation to complete
            }
          }
          expect(evalResult).toEqual({ crossOriginIsolated: true, hasSAB: true });
        } finally {
          proc.kill();
        }
      }
    } finally {
      await devServer.close();
    }

    await build({
      root: webRoot,
      configFile: path.join(webRoot, 'vite.config.ts'),
      logLevel: 'silent',
    });

    const previewServer = await preview({
      root: webRoot,
      configFile: path.join(webRoot, 'vite.config.ts'),
      preview: { port: 0, host: '127.0.0.1' },
      logLevel: 'silent',
    });
    try {
      const address = previewServer.httpServer.address();
      expect(address).toBeTruthy();
      const port = typeof address === 'object' && address !== null ? address.port : 4173;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    } finally {
      await new Promise<void>((resolve, reject) => {
        previewServer.httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }, 15000);

  it('detects crossOriginIsolated context and operates atomic SharedArrayBuffer ring-buffers in core-bridge', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');
    try {
      Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true });
      expect(isCrossOriginIsolatedContext()).toBe(true);

      Object.defineProperty(globalThis, 'crossOriginIsolated', { value: false, configurable: true });
      expect(isCrossOriginIsolatedContext()).toBe(false);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'crossOriginIsolated', descriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'crossOriginIsolated');
      }
    }

    expect(() => createSharedRingBuffer(0)).toThrow(RangeError);
    expect(() => createSharedRingBuffer(-4)).toThrow(RangeError);

    const view = createSharedRingBuffer(16);
    expect(view.control.length).toBe(RING_BUFFER_HEADER_WORDS);
    expect(view.payload.length).toBe(16);
    expect(readRingBufferWriteIndexAtomically(view)).toBe(0);
    expect(readRingBufferReadIndexAtomically(view)).toBe(0);

    view.payload[0] = 12;
    view.payload[1] = 112;
    Atomics.store(view.control, RING_CONTROL_WRITE_INDEX, 2);
    expect(readRingBufferWriteIndexAtomically(view)).toBe(2);

    commitRingBufferReadIndexAtomically(view, 2);
    expect(readRingBufferReadIndexAtomically(view)).toBe(2);
  });

  it('provides all modular frontend architecture directories and evaluates preset/renderer contracts', () => {
    const requiredModules = [
      'src/domain-contracts/index.ts',
      'src/core-bridge/index.ts',
      'src/preset-engine/index.ts',
      'src/renderer-webgl/index.ts',
      'src/views/studio-view/index.ts',
      'src/views/blueprint-view/index.ts',
      'src/views/player-view/index.ts',
    ];

    for (const relPath of requiredModules) {
      const fullPath = path.join(webRoot, relPath);
      expect(fs.existsSync(fullPath), `Expected ${relPath} to exist`).toBe(true);
    }

    expect(DEFAULT_OPTIONS.resolutionPx).toBeGreaterThanOrEqual(200);
    expect(PRESETS['portrait-mono']).toBeDefined();
    expect(PRESETS['portrait-cmyk'].colorStrategy).toBe('layered');

    const circleRule = { controlId: 'diameter', visibleWhenShapes: ['circle'] as const };
    expect(isSliderVisible(circleRule, { shape: 'circle', algorithm: 'greedy', strategy: 'mono' })).toBe(true);
    expect(isSliderVisible(circleRule, { shape: 'rectangle', algorithm: 'greedy', strategy: 'mono' })).toBe(false);

    expect(detectRendererCapabilities(null).backend).toBe('canvas2d-fallback');
    const mockWebGL2Canvas = {
      getContext: (id: string) =>
        id === 'webgl2'
          ? {
              MAX_TEXTURE_SIZE: 0x0d33,
              getExtension: (name: string) => (name === 'EXT_color_buffer_float' ? {} : null),
              getParameter: () => 8192,
            }
          : null,
    };
    const caps = detectRendererCapabilities(mockWebGL2Canvas);
    expect(caps.backend).toBe('webgl2-rgba16f');
    expect(caps.supportsColorBufferFloat).toBe(true);
    expect(caps.maxTextureSizePx).toBe(8192);
  });

  it('defines the Rust Cargo Workspace and enforces Clean Architecture dependency rules', () => {
    const rootCargoPath = path.join(repoRoot, 'Cargo.toml');
    expect(fs.existsSync(rootCargoPath)).toBe(true);
    const rootCargo = fs.readFileSync(rootCargoPath, 'utf8');

    expect(rootCargo).toContain('[workspace]');
    expect(rootCargo).toContain('resolver = "2"');
    expect(rootCargo).toContain('[profile.release]');
    expect(rootCargo).toContain('opt-level = 3');
    expect(rootCargo).toContain('lto = "fat"');
    expect(rootCargo).toContain('codegen-units = 1');

    const expectedCrates = [
      { dir: 'crates/weaver-domain', entry: 'src/lib.rs', allowedInternalDeps: [] },
      { dir: 'crates/weaver-dsp', entry: 'src/lib.rs', allowedInternalDeps: ['weaver-domain'] },
      { dir: 'crates/weaver-solvers', entry: 'src/lib.rs', allowedInternalDeps: ['weaver-domain'] },
      { dir: 'crates/weaver-cam', entry: 'src/lib.rs', allowedInternalDeps: ['weaver-domain'] },
      {
        dir: 'crates/weaver-wasm-adapter',
        entry: 'src/lib.rs',
        allowedInternalDeps: ['weaver-domain', 'weaver-dsp', 'weaver-solvers', 'weaver-cam'],
      },
      {
        dir: 'crates/weaver-cli',
        entry: 'src/main.rs',
        allowedInternalDeps: ['weaver-domain', 'weaver-dsp', 'weaver-solvers', 'weaver-cam'],
      },
    ];

    const allCrateNames = [
      'weaver-domain',
      'weaver-dsp',
      'weaver-solvers',
      'weaver-cam',
      'weaver-wasm-adapter',
      'weaver-cli',
    ];

    for (const crate of expectedCrates) {
      expect(rootCargo).toContain(`"${crate.dir}"`);
      const cargoTomlPath = path.join(repoRoot, crate.dir, 'Cargo.toml');
      const entryPath = path.join(repoRoot, crate.dir, crate.entry);
      expect(fs.existsSync(cargoTomlPath), `Missing ${crate.dir}/Cargo.toml`).toBe(true);
      expect(fs.existsSync(entryPath), `Missing ${crate.dir}/${crate.entry}`).toBe(true);

      const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
      const withoutPackageSection = cargoToml.replace(/\[package\][\s\S]*?(?=\n\[|$)/, '');

      for (const internalCrate of allCrateNames) {
        const depRegex = new RegExp(`^\\s*${internalCrate}\\s*=`, 'm');
        if (crate.allowedInternalDeps.includes(internalCrate)) {
          expect(depRegex.test(withoutPackageSection), `${crate.dir} should depend on ${internalCrate}`).toBe(true);
        } else {
          expect(depRegex.test(withoutPackageSection), `${crate.dir} must NOT depend on ${internalCrate}`).toBe(false);
        }
      }
    }
  });
});
