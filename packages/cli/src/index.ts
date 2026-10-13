#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import {
  PRESETS,
  resolveOptions,
  toCSV,
  toInstructions,
  toSVG,
  WeaveEngine,
  type DeepPartial,
  type PresetName,
  type RasterImage,
  type WeaveOptions,
} from '@weaver-art/core';

const HELP = `
weaver-art — converte uma imagem em um padrão de tecelagem em tear circular.

Uso:
  weaver-art <imagem> [opções]

Opções:
  -p, --preset <nome>        vrellis-mono (padrão) | vrellis-color
      --pegs <n>             número de pinos (padrão 200)
      --diameter <mm>        diâmetro do círculo dos pinos (padrão 711.2 = 28″)
      --peg-diameter <mm>    diâmetro do pino; 0 = pinos ideais (padrão 2)
      --lines <n>            máximo de linhas/cordas (padrão 4000)
      --gap <n>              distância mínima entre pinos consecutivos (padrão 12)
      --repeats <n>          usos máximos de um mesmo par de pinos (padrão 1)
      --thread-width <mm>    largura aparente do fio (padrão 0.2)
      --resolution <px>      grade de simulação = distância de observação (padrão 400)
      --contrast <x>         contraste (padrão 1)
      --brightness <x>       brilho, -1..1 (padrão 0)
      --gamma <x>            gama (padrão 1)
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
      pegs: { type: 'string' },
      diameter: { type: 'string' },
      'peg-diameter': { type: 'string' },
      lines: { type: 'string' },
      gap: { type: 'string' },
      repeats: { type: 'string' },
      'thread-width': { type: 'string' },
      resolution: { type: 'string' },
      contrast: { type: 'string' },
      brightness: { type: 'string' },
      gamma: { type: 'string' },
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
      threads: threadWidth === undefined ? undefined : options.threads.map((t) => ({ ...t, widthMm: threadWidth })),
      preprocess: {
        contrast: num(values.contrast, 'contrast'),
        brightness: num(values.brightness, 'brightness'),
        gamma: num(values.gamma, 'gamma'),
        invert: values.invert,
      },
    },
    options,
  );

  const image = await loadRaster(input);
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
  process.stderr.write(
    [
      `✔ ${result.steps.length} linhas · ${(result.totalLengthMm / 1000).toFixed(2)} m de fio · RMSE ${result.rmse.toFixed(4)}`,
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
