#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import {
  calibrateThreadColor,
  extractPalette,
  PRESETS,
  resolveOptions,
  toCSV,
  toInstructions,
  toSVG,
  WeaveEngine,
  type DeepPartial,
  type PresetName,
  type RasterImage,
  type ThreadConfig,
  type WeaveOptions,
} from '@weaver-art/core';

const HELP = `
weaver-art — converte uma imagem em um padrão de tecelagem em tear circular.

Uso:
  weaver-art <imagem> [opções]
  weaver-art calibrate-color <imagem>
  weaver-art extract-palette <imagem> [k]

Opções:
  -p, --preset <nome>        vrellis-mono (padrão) | vrellis-color | cmyk
      --auto-palette <k>     extrai paleta de k cores da imagem automaticamente (padrão 4)
      --halftone             ativa modelo óptico de mistura por meio-tom
      --halftone-radius <mm> raio de mistura por meio-tom em mm (padrão 0.75)
      --color-strategy <s>   layered (padrão) | interleaved-balanced | free
      --pegs <n>             número de pinos (padrão 200)
      --diameter <mm>        diâmetro do círculo dos pinos (padrão 711.2 = 28″)
      --peg-diameter <mm>    diâmetro do pino; 0 = pinos ideais (padrão 2)
      --lines <n>            máximo de linhas/cordas (padrão 4000)
      --gap <n>              distância mínima entre pinos consecutivos (padrão 12)
      --repeats <n>          usos máximos de um mesmo par de pinos (padrão 1)
      --thread-width <mm>    largura aparente do fio (padrão 0.2)
      --resolution <px>      grade de simulação (padrão 400)
      --length-penalty <x>   penalidade por comprimento de fio 0..1 (padrão 0)
      --viewing-distance <m> distância de observação em metros para desfoque retiniano (padrão 0)
      --refine <n>           passes de refinamento pós-guloso mantendo continuidade (padrão 0)
      --contrast <x>         contraste (padrão 1)
      --brightness <x>       brilho, -1..1 (padrão 0)
      --gamma <x>            gama (padrão 1)
      --shadow-lift <x>      elevação de sombras 0..0.3 (padrão 0)
      --edge-emphasis <x>    realce de bordas/feições 0..1 (padrão 0)
      --clahe                ativa equalização local de contraste adaptativa (CLAHE)
      --clahe-clip <x>       limite de corte do CLAHE (padrão 2.0)
      --invert               inverte a imagem (fio claro em fundo escuro)
      --background <#hex>    cor do fundo (padrão #ffffff)
      --importance <imagem>  mapa de importância (branco = importante)
      --config <arquivo>     JSON com WeaveOptions parciais (aplicado antes das flags)
      --no-stop              não parar quando nenhuma linha melhora o resultado
  -o, --out <pasta>          pasta de saída (padrão ./output)
  -n, --name <nome>          nome base dos arquivos (padrão: nome da imagem)
  -h, --help                 mostra esta ajuda
`;

async function loadRaster(file: string): Promise<RasterImage> {
  const { data, info } = await sharp(file)
    .rotate() // honour EXIF orientation (phone photos)
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
  };
}

async function writePng(file: string, rgba: Uint8ClampedArray, size: number): Promise<void> {
  await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length), {
    raw: { width: size, height: size, channels: 4 },
  })
    .png()
    .toFile(file);
}

function num(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Valor inválido para --${flag}: ${v}`);
  return n;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      preset: { type: 'string', short: 'p', default: 'vrellis-mono' },
      'auto-palette': { type: 'string' },
      halftone: { type: 'boolean' },
      'halftone-radius': { type: 'string' },
      'color-strategy': { type: 'string' },
      pegs: { type: 'string' },
      diameter: { type: 'string' },
      'peg-diameter': { type: 'string' },
      lines: { type: 'string' },
      gap: { type: 'string' },
      repeats: { type: 'string' },
      'thread-width': { type: 'string' },
      resolution: { type: 'string' },
      'length-penalty': { type: 'string' },
      'viewing-distance': { type: 'string' },
      refine: { type: 'string' },
      contrast: { type: 'string' },
      brightness: { type: 'string' },
      gamma: { type: 'string' },
      'shadow-lift': { type: 'string' },
      'edge-emphasis': { type: 'string' },
      clahe: { type: 'boolean' },
      'clahe-clip': { type: 'string' },
      invert: { type: 'boolean' },
      background: { type: 'string' },
      importance: { type: 'string' },
      config: { type: 'string' },
      stop: { type: 'boolean', default: true },
      out: { type: 'string', short: 'o', default: 'output' },
      name: { type: 'string', short: 'n' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    process.exit(values.help ? 0 : 1);
  }

  if (positionals[0] === 'extract-palette') {
    const palFile = positionals[1];
    if (!palFile) {
      process.stderr.write('Erro: especifique a imagem. Uso: weaver-art extract-palette <imagem> [k]\n');
      process.exit(1);
    }
    const k = positionals[2] ? Number(positionals[2]) : values['auto-palette'] ? Number(values['auto-palette']) : 4;
    const palImg = await loadRaster(palFile);
    const result = extractPalette(palImg, k);
    process.stdout.write(`\nPaleta extraída da imagem (${result.threads.length} cores):\n`);
    process.stdout.write(
      `${'#'.padEnd(3)} ${'Hex'.padEnd(9)} ${'Cota (%)'.padEnd(10)} ${'Pino Inicial'.padEnd(14)} Nome\n`,
    );
    process.stdout.write(`${'-'.repeat(55)}\n`);
    result.threads.forEach((t: ThreadConfig, i: number) => {
      const quotaPct = ((result.threadLineBudgets[i] ?? 0) * 100).toFixed(1) + '%';
      process.stdout.write(
        `${String(i + 1).padEnd(3)} ${t.color.padEnd(9)} ${quotaPct.padEnd(10)} ${String(t.startPeg).padEnd(14)} ${t.name}\n`,
      );
    });
    process.stdout.write('\nConfiguração JSON sugerida:\n');
    process.stdout.write(
      JSON.stringify(
        {
          threads: result.threads,
          threadLineBudgets: result.threadLineBudgets,
        },
        null,
        2,
      ) + '\n\n',
    );
    return;
  }

  if (positionals[0] === 'calibrate-color') {
    const calFile = positionals[1];
    if (!calFile) {
      process.stderr.write('Erro: especifique a imagem para calibração. Uso: weaver-art calibrate-color <imagem>\n');
      process.exit(1);
    }
    const calImg = await loadRaster(calFile);
    const calRes = calibrateThreadColor(calImg);
    process.stdout.write(
      `✔ Cor calibrada: ${calRes.hex} (RGB linear: [${calRes.linearRgb.map((v) => v.toFixed(4)).join(', ')}]) · ${calRes.sampleCount} pixels amostrados\n`,
    );
    return;
  }

  const input = positionals[0];
  const presetName = values.preset as PresetName;
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`Preset desconhecido: ${values.preset}. Use: ${Object.keys(PRESETS).join(', ')}`);

  const fileConfig: DeepPartial<WeaveOptions> = values.config
    ? (JSON.parse(await readFile(values.config, 'utf8')) as DeepPartial<WeaveOptions>)
    : {};
  let options = resolveOptions(fileConfig, preset);

  const threadWidth = num(values['thread-width'], 'thread-width');
  options = resolveOptions(
    {
      loom: {
        pegCount: num(values.pegs, 'pegs'),
        diameterMm: num(values.diameter, 'diameter'),
        pegDiameterMm: num(values['peg-diameter'], 'peg-diameter'),
      },
      maxLines: num(values.lines, 'lines'),
      minPegGap: num(values.gap, 'gap'),
      maxChordRepeats: num(values.repeats, 'repeats'),
      resolutionPx: num(values.resolution, 'resolution'),
      background: values.background,
      stopWhenNoImprovement: values.stop,
      colorStrategy: values['color-strategy'] as WeaveOptions['colorStrategy'],
      lengthPenalty: num(values['length-penalty'], 'length-penalty'),
      viewingDistanceM: num(values['viewing-distance'], 'viewing-distance'),
      refinePasses: num(values.refine, 'refine'),
      halftoneMixing: values.halftone ? true : undefined,
      halftoneRadiusMm: num(values['halftone-radius'], 'halftone-radius'),
      threads: threadWidth === undefined ? undefined : options.threads.map((t) => ({ ...t, widthMm: threadWidth })),
      preprocess: {
        contrast: num(values.contrast, 'contrast'),
        brightness: num(values.brightness, 'brightness'),
        gamma: num(values.gamma, 'gamma'),
        shadowLift: num(values['shadow-lift'], 'shadow-lift'),
        edgeEmphasis: num(values['edge-emphasis'], 'edge-emphasis'),
        clahe: values.clahe,
        claheClipLimit: num(values['clahe-clip'], 'clahe-clip'),
        viewingDistanceM: num(values['viewing-distance'], 'viewing-distance'),
        invert: values.invert,
      },
    },
    options,
  );

  const image = await loadRaster(input);
  if (values['auto-palette'] !== undefined) {
    const k = Number(values['auto-palette']) || 4;
    const autoPal = extractPalette(image, k, {
      loomPegCount: options.loom.pegCount,
      threadWidthMm: threadWidth,
    });
    options.threads = autoPal.threads;
    options.threadLineBudgets = autoPal.threadLineBudgets;
    options.preprocess.grayscale = false;
  }
  const importance = values.importance ? await loadRaster(values.importance) : undefined;
  const engine = new WeaveEngine(image, options, importance);

  const { loom } = options;
  process.stderr.write(
    `Tear Ø${loom.diameterMm.toFixed(1)} mm · ${loom.pegCount} pinos · grade ${options.resolutionPx}px · ` +
      `${options.threads.map((t) => t.name).join(', ')}\n`,
  );

  const result = engine.run({
    progressEvery: 25,
    onProgress: (e) => {
      const pct = ((e.steps.length / options.maxLines) * 100).toFixed(1);
      process.stderr.write(
        `\r  linhas ${e.steps.length}/${options.maxLines} (${pct}%) · fio ${(e.totalLengthMm / 1000).toFixed(1)} m   `,
      );
    },
  });
  process.stderr.write('\n');

  const outDir = path.resolve(values.out);
  await mkdir(outDir, { recursive: true });
  const base = path.join(outDir, values.name ?? path.parse(input).name);
  await Promise.all([
    writeFile(`${base}.weave.json`, JSON.stringify(result)),
    writeFile(`${base}.weave.txt`, toInstructions(result)),
    writeFile(`${base}.weave.csv`, toCSV(result)),
    writeFile(`${base}.weave.svg`, toSVG(result)),
    writePng(`${base}.weave.png`, engine.toRGBA(), engine.size),
    writePng(`${base}.target.png`, engine.targetToRGBA(), engine.size),
  ]);

  const reasons: Record<string, string> = {
    'max-lines': 'limite de linhas atingido',
    'no-improvement': 'nenhuma linha melhora mais o resultado',
    'no-candidates': 'sem cordas disponíveis',
    aborted: 'interrompido',
  };
  const deltaEStr = result.metrics?.deltaELab !== undefined ? ` · ΔE ${result.metrics.deltaELab.toFixed(2)}` : '';
  const ssimStr = result.metrics?.ssim !== undefined ? ` · SSIM ${result.metrics.ssim.toFixed(3)}` : '';
  process.stderr.write(
    [
      `✔ ${result.steps.length} linhas · ${(result.totalLengthMm / 1000).toFixed(2)} m de fio · RMSE ${result.rmse.toFixed(4)}${deltaEStr}${ssimStr}`,
      `  parada: ${reasons[result.stopReason]} · ${(result.durationMs / 1000).toFixed(1)} s`,
      `  arquivos: ${base}.weave.{json,txt,csv,svg,png}`,
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`\nErro: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
