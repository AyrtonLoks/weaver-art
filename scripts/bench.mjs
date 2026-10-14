import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import {
  WeaveEngine,
  createSharedBuffers,
  createSharedControl,
  ParallelEvaluator,
} from '../packages/core/dist/index.js';
import { instantiateWasmKernel } from '../packages/wasm/dist/index.js';

function makeSyntheticImage(size = 400) {
  const data = new Uint8ClampedArray(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      // Soft radial gradient + high-frequency rings
      const ring = Math.sin(d * 0.15) > 0 ? 30 : 180;
      const val = d < r ? ring : 245;
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
      data[idx + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

async function runBenchmarkConfig(name, image, options, createEvaluator) {
  const engine = await WeaveEngine.createAsync(image, options, undefined, {
    evaluator: createEvaluator,
  });

  const t0 = performance.now();
  const res = engine.run();
  const durationMs = performance.now() - t0;
  engine.dispose();

  const chordsPerSec = (res.steps.length / (durationMs / 1000)).toFixed(1);
  return {
    name,
    steps: res.steps.length,
    durationMs,
    durationSec: (durationMs / 1000).toFixed(3),
    chordsPerSec: Number(chordsPerSec),
    rmse: res.rmse.toFixed(4),
    ssim: (res.metrics?.ssim ?? 0).toFixed(4),
  };
}

async function main() {
  const cpus = os.cpus();
  console.log(`\n======================================================`);
  console.log(` Weaver Art v0.5.0 Benchmark (Desempenho)`);
  console.log(` CPU: ${cpus[0]?.model || 'Unknown'} (${cpus.length} cores)`);
  console.log(` Node: ${process.version} · Platform: ${process.platform} (${process.arch})`);
  console.log(`======================================================\n`);

  const size = 400;
  const pegCount = 200;
  const maxLines = 150;
  const image = makeSyntheticImage(size);

  const baseOptions = {
    resolutionPx: size,
    maxLines,
    loom: {
      shape: 'circle',
      diameterMm: 711.2,
      pegCount,
      startAngleDeg: -90,
      pegDiameterMm: 2,
    },
    threads: [
      {
        id: 't0',
        name: 'Preto',
        color: '#000000',
        widthMm: 0.2,
        opacity: 0.18,
        startPeg: 0,
      },
    ],
    minPegGap: 12,
    maxChordRepeats: 1,
    stopWhenNoImprovement: false,
  };

  // Warmup run
  console.log('Executando aquecimento JIT / WASM...');
  const warmup = await WeaveEngine.createAsync(image, { ...baseOptions, maxLines: 20 }, undefined, {
    evaluator: (setup) => instantiateWasmKernel(setup),
  });
  warmup.run();
  warmup.dispose();
  console.log('Aquecimento concluído.\n');

  const configs = [
    {
      id: 'js-nocache',
      name: 'JS (Sem Cache, Sem Poda)',
      options: { ...baseOptions, rasterCacheMb: 0, candidatePruning: 'none' },
      factory: undefined,
    },
    {
      id: 'js-cached',
      name: 'JS (ChordCache 128MB, Sem Poda)',
      options: { ...baseOptions, rasterCacheMb: 128, candidatePruning: 'none' },
      factory: undefined,
    },
    {
      id: 'js-lazy',
      name: 'JS (ChordCache + Lazy Pruning)',
      options: { ...baseOptions, rasterCacheMb: 128, candidatePruning: 'lazy' },
      factory: undefined,
    },
    {
      id: 'wasm-simd',
      name: 'Rust SIMD WASM (Sem Poda)',
      options: { ...baseOptions, candidatePruning: 'none' },
      factory: (setup) => instantiateWasmKernel(setup),
    },
    {
      id: 'wasm-lazy',
      name: 'Rust SIMD WASM + Lazy Pruning',
      options: { ...baseOptions, candidatePruning: 'lazy' },
      factory: (setup) => instantiateWasmKernel(setup),
    },
    {
      id: 'parallel-2t',
      name: 'Paralelo (2 threads / workers)',
      options: { ...baseOptions, candidatePruning: 'none' },
      factory: (setup) => {
        const workerCount = 2;
        const sharedCtrl = createSharedControl(workerCount);
        const { buffers, descriptor: buffersDesc } = createSharedBuffers(setup, false);
        const workers = [];
        for (let w = 1; w < workerCount; w++) {
          const worker = new Worker(new URL('../packages/cli/dist/helper.js', import.meta.url));
          worker.postMessage({
            type: 'start',
            workerIndex: w,
            workerCount,
            controlDesc: sharedCtrl.descriptor,
            setup,
            buffersDesc,
          });
          workers.push(worker);
        }
        const parEval = new ParallelEvaluator({
          workerCount,
          setup,
          buffers,
          sharedControl: sharedCtrl,
          onDispose: () => workers.forEach((w) => w.terminate()),
        });
        parEval.waitUntilReady();
        return parEval;
      },
    },
    {
      id: 'parallel-4t',
      name: 'Paralelo (4 threads / workers)',
      options: { ...baseOptions, candidatePruning: 'none' },
      factory: (setup) => {
        const workerCount = 4;
        const sharedCtrl = createSharedControl(workerCount);
        const { buffers, descriptor: buffersDesc } = createSharedBuffers(setup, false);
        const workers = [];
        for (let w = 1; w < workerCount; w++) {
          const worker = new Worker(new URL('../packages/cli/dist/helper.js', import.meta.url));
          worker.postMessage({
            type: 'start',
            workerIndex: w,
            workerCount,
            controlDesc: sharedCtrl.descriptor,
            setup,
            buffersDesc,
          });
          workers.push(worker);
        }
        const parEval = new ParallelEvaluator({
          workerCount,
          setup,
          buffers,
          sharedControl: sharedCtrl,
          onDispose: () => workers.forEach((w) => w.terminate()),
        });
        parEval.waitUntilReady();
        return parEval;
      },
    },
  ];

  const results = [];
  for (const cfg of configs) {
    process.stdout.write(`Benchmarking: ${cfg.name}... `);
    const res = await runBenchmarkConfig(cfg.name, image, cfg.options, cfg.factory);
    results.push(res);
    process.stdout.write(`${res.durationSec}s (${res.chordsPerSec} cordas/s)\n`);
  }

  const baseline = results[0];
  console.log(`\n### Resultados Comparativos (grade ${size}px, ${pegCount} pinos, ${maxLines} cordas):\n`);
  console.log(`| Configuração | Cordas | Tempo (s) | Cordas/s | Speedup vs Baseline | RMSE | SSIM |`);
  console.log(`|:---|:---:|:---:|:---:|:---:|:---:|:---:|`);

  for (const r of results) {
    const speedup = (baseline.durationMs / r.durationMs).toFixed(2) + 'x';
    console.log(
      `| ${r.name.padEnd(32)} | ${String(r.steps).padStart(6)} | ${r.durationSec.padStart(9)} | ${String(r.chordsPerSec).padStart(8)} | ${speedup.padStart(19)} | ${r.rmse} | ${r.ssim} |`,
    );
  }
  console.log('\n✔ Benchmark concluído com sucesso.\n');
}

main().catch((err) => {
  console.error('Erro no benchmark:', err);
  process.exit(1);
});
