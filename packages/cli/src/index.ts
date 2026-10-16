#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import {
  calibrateThreadColor,
  describeLoom,
  estimateWeave,
  extractPalette,
  formatDuration,
  gcodePathLengthMm,
  loomPegCount,
  parsePegsCSV,
  PRESETS,
  resolveOptions,
  toCSV,
  toGcode,
  toInstructions,
  toPegsCSV,
  toSVG,
  toTemplatePDF,
  toTemplateSVG,
  WeaveEngine,
  type CircleLoomConfig,
  type CustomLoomConfig,
  type DeepPartial,
  type EvaluatorSetup,
  type GcodeOptions,
  type LoomConfig,
  type PaperSize,
  type PresetName,
  type RasterImage,
  type RectangleLoomConfig,
  type ThreadConfig,
  type WeaveOptions,
  type WeaveResult,
} from '@weaver-art/core';
import { instantiateWasmKernel } from '@weaver-art/wasm';

const HELP = `
weaver-art — computação de string art / tecelagem em tear circular ou retangular.

Uso:
  weaver-art <imagem> [opções]
  weaver-art template [opções de tear] [--paper A4|A3|Letter] [--drill <mm>] -o <pasta>
  weaver-art gcode <projeto.weave.json> [opções de gcode] -o <pasta>
  weaver-art estimate <projeto.weave.json> [opções de estimativa]
  weaver-art calibrate-color <imagem>
  weaver-art extract-palette <imagem> [k]

Forma e dimensões do tear:
  --shape <s>            circle (padrão) | square | rectangle | custom
  --pegs <n>             número de pinos (padrão 200 no círculo)
  --diameter <mm>        diâmetro do círculo ou lado do quadrado (padrão 711.2 = 28″)
  --width <mm>           largura do tear retangular em mm (padrão 600)
  --height <mm>          altura do tear retangular em mm (padrão 400)
  --pegs-x <n>           pinos nas bordas horizontais (retângulo)
  --pegs-y <n>           pinos nas bordas verticais (retângulo)
  --pegs-csv <arquivo>   arquivo CSV com coordenadas x,y dos pinos em mm
  --peg-diameter <mm>    diâmetro do pino; 0 = pinos ideais (padrão 2)

Fabricação e Gabarito:
  --paper <formato>      formato do papel do gabarito: A4 (padrão) | A3 | Letter
  --drill <mm>           diâmetro dos furos de furação em mm (padrão 2)
  --margin <mm>          margem ao redor do tear no gabarito em mm
  --gcode                gera arquivo G-code (.weave.gcode) para plotter/CNC
  --clearance <mm>       folga radial da ferramenta além do pino em mm (padrão 1.5)
  --feed <mm/min>        velocidade de avanço de tecelagem (padrão 3000)
  --origin <pos>         origem de coordenadas: bottom-left (padrão) | top-left | center

Estimativa e Carretéis:
  --sec-per-chord <n>    segundos médios por corda manual (padrão 6)
  --spool <m>            comprimento do carretel de fio em metros (padrão 1000)
  --spool-margin <pct>   margem de segurança no fio em % (padrão 10)

Opções do algoritmo de tecelagem:
  -p, --preset <nome>        portrait-mono | portrait-cmyk | vrellis-mono (padrão) | vrellis-color | cmyk
      --auto-palette <k>     extrai paleta de k cores da imagem automaticamente (padrão 4)
      --halftone             ativa modelo óptico de mistura por meio-tom
      --halftone-radius <mm> raio de mistura por meio-tom em mm (padrão 0.75)
      --color-strategy <s>   layered (padrão) | interleaved-balanced | free
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
      --highlight-protection <x> penalidade em realces claros 0..10 (padrão 0 ou 2.5 em portrait)
      --angular-diversity <x> diversidade direcional entre cordas 0..1 (padrão 0 ou 0.35 em portrait)
      --center-damp <mm>     raio de atenuação cáustica no centro em mm (padrão 0 ou 25 em portrait)
      --sharpen-sigma <x>    desfoque para máscara de nitidez unsharp mask (padrão 0 ou 1.5 em portrait)
      --torso-feathering <x> atenuação suave de densidade na base do retrato 0..1 (padrão 0 ou 0.25 em portrait)
      --clahe                ativa equalização local de contraste adaptativa (CLAHE)
      --clahe-clip <x>       limite de corte do CLAHE (padrão 2.0)
      --invert               inverte a imagem (fio claro em fundo escuro)
      --background <#hex>    cor do fundo (padrão #ffffff)
      --importance <imagem>  mapa de importância (branco = importante)
      --config <arquivo>     JSON com WeaveOptions parciais (aplicado antes das flags)
      --no-stop              não parar quando nenhuma linha melhora o resultado

Aceleração e Desempenho:
      --accel <motor>        js (padrão) | wasm (Rust SIMD) | parallel (threads)
      --threads <n>          número de threads para --accel parallel (padrão: CPUs)
      --pruning <modo>       none (padrão) | lazy (busca gulosa preguiçosa Minoux 1978)
      --cache-mb <n>         orçamento do cache de rasterização em MB (padrão 128)
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

async function buildLoomConfig(
  values: Record<string, string | boolean | undefined>,
  baseLoom: LoomConfig = {
    shape: 'circle',
    diameterMm: 711.2,
    pegCount: 200,
    pegDiameterMm: 2,
    startAngleDeg: -90,
  },
): Promise<LoomConfig> {
  const shape = (values.shape as LoomConfig['shape'] | 'square' | undefined) ?? baseLoom.shape;
  const pegDiameterMm = num(values['peg-diameter'] as string, 'peg-diameter') ?? baseLoom.pegDiameterMm;

  if (shape === 'custom' || values['pegs-csv']) {
    const csvPath = values['pegs-csv'] as string | undefined;
    if (!csvPath && baseLoom.shape !== 'custom') {
      throw new Error('Forma "custom" exige o arquivo CSV via --pegs-csv <arquivo>');
    }
    const pegs = csvPath ? parsePegsCSV(await readFile(csvPath, 'utf8')) : (baseLoom as CustomLoomConfig).pegs;
    return {
      shape: 'custom',
      pegDiameterMm,
      pegs,
    };
  }

  if (shape === 'rectangle' || shape === 'square') {
    const isSquare = shape === 'square';
    const baseRect = baseLoom.shape === 'rectangle' ? (baseLoom as RectangleLoomConfig) : null;
    const widthMm =
      num(values.width as string, 'width') ??
      (isSquare ? num(values.diameter as string, 'diameter') : undefined) ??
      baseRect?.widthMm ??
      (isSquare ? 500 : 600);
    const heightMm = isSquare ? widthMm : (num(values.height as string, 'height') ?? baseRect?.heightMm ?? 400);

    let pegsX = num(values['pegs-x'] as string, 'pegs-x');
    let pegsY = num(values['pegs-y'] as string, 'pegs-y');

    if (pegsX === undefined && pegsY === undefined && values.pegs) {
      const total = Number(values.pegs);
      if (isSquare) {
        pegsX = Math.round(total / 4) + 1;
        pegsY = pegsX;
      } else {
        const perimeter = 2 * (widthMm + heightMm);
        pegsX = Math.max(2, Math.round(((total / 2) * widthMm) / perimeter) + 1);
        pegsY = Math.max(2, Math.round(((total / 2) * heightMm) / perimeter) + 1);
      }
    }

    return {
      shape: 'rectangle',
      pegDiameterMm,
      widthMm,
      heightMm,
      pegsX: pegsX ?? baseRect?.pegsX ?? 51,
      pegsY: pegsY ?? (isSquare ? (pegsX ?? baseRect?.pegsX ?? 51) : (baseRect?.pegsY ?? 35)),
    };
  }

  const baseCircle = baseLoom.shape === 'circle' ? (baseLoom as CircleLoomConfig) : null;
  return {
    shape: 'circle',
    pegDiameterMm,
    diameterMm: num(values.diameter as string, 'diameter') ?? baseCircle?.diameterMm ?? 711.2,
    pegCount: num(values.pegs as string, 'pegs') ?? baseCircle?.pegCount ?? 200,
    startAngleDeg: baseCircle?.startAngleDeg ?? -90,
  };
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
      shape: { type: 'string' },
      pegs: { type: 'string' },
      diameter: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      'pegs-x': { type: 'string' },
      'pegs-y': { type: 'string' },
      'pegs-csv': { type: 'string' },
      'peg-diameter': { type: 'string' },
      paper: { type: 'string' },
      drill: { type: 'string' },
      margin: { type: 'string' },
      gcode: { type: 'boolean' },
      clearance: { type: 'string' },
      feed: { type: 'string' },
      origin: { type: 'string' },
      'sec-per-chord': { type: 'string' },
      spool: { type: 'string' },
      'spool-margin': { type: 'string' },
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
      'highlight-protection': { type: 'string' },
      'angular-diversity': { type: 'string' },
      'center-damp': { type: 'string' },
      'sharpen-sigma': { type: 'string' },
      'torso-feathering': { type: 'string' },
      clahe: { type: 'boolean' },
      'clahe-clip': { type: 'string' },
      invert: { type: 'boolean' },
      background: { type: 'string' },
      importance: { type: 'string' },
      config: { type: 'string' },
      accel: { type: 'string', default: 'js' },
      threads: { type: 'string' },
      pruning: { type: 'string', default: 'none' },
      'cache-mb': { type: 'string' },
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

  // Subcomando: template
  if (positionals[0] === 'template') {
    const loomCfg = await buildLoomConfig(values);
    const outDir = path.resolve(values.out);
    await mkdir(outDir, { recursive: true });
    const name = values.name ?? `loom-${loomCfg.shape}`;
    const base = path.join(outDir, name);
    const paper = (values.paper as PaperSize) ?? 'A4';
    const drillHole = num(values.drill, 'drill');
    const marginMm = num(values.margin, 'margin');

    const svg = toTemplateSVG(loomCfg, { drillDiameterMm: drillHole, marginMm });
    const pdf = toTemplatePDF(loomCfg, { paper, drillDiameterMm: drillHole, marginMm });
    const csv = toPegsCSV(loomCfg);

    await Promise.all([
      writeFile(`${base}.template.svg`, svg, 'utf8'),
      writeFile(`${base}.template.pdf`, pdf),
      writeFile(`${base}.pegs.csv`, csv, 'utf8'),
    ]);

    process.stdout.write(`✔ Gabarito de fabricação gerado:\n`);
    process.stdout.write(`  ${describeLoom(loomCfg)}\n`);
    process.stdout.write(`  Papel: ${paper} (escala real 1:1 com marcas de registro e régua de verificação)\n`);
    process.stdout.write(`  Arquivos salvos em ${outDir}:\n`);
    process.stdout.write(`    - ${name}.template.svg (corte a laser / CNC)\n`);
    process.stdout.write(`    - ${name}.template.pdf (impressão multi-folhas 1:1)\n`);
    process.stdout.write(`    - ${name}.pegs.csv (coordenadas dos pinos em mm)\n\n`);
    return;
  }

  // Subcomando: gcode
  if (positionals[0] === 'gcode') {
    const jsonPath = positionals[1];
    if (!jsonPath) {
      process.stderr.write(
        'Erro: especifique o arquivo .weave.json. Uso: weaver-art gcode <projeto.weave.json> [opções]\n',
      );
      process.exit(1);
    }
    const raw = await readFile(jsonPath, 'utf8');
    const result = JSON.parse(raw) as WeaveResult;
    const clearance = num(values.clearance, 'clearance');
    const feed = num(values.feed, 'feed');
    const origin = values.origin as GcodeOptions['origin'];

    const gcodeStr = toGcode(result, {
      clearanceMm: clearance,
      feedMmPerMin: feed,
      origin,
    });

    const outDir = path.resolve(values.out);
    await mkdir(outDir, { recursive: true });
    const name = values.name ?? path.parse(jsonPath).name.replace(/\.weave$/, '');
    const outPath = path.join(outDir, `${name}.weave.gcode`);
    await writeFile(outPath, gcodeStr, 'utf8');

    const totalLength = gcodePathLengthMm(result, { clearanceMm: clearance });
    process.stdout.write(`✔ G-code gerado com sucesso:\n`);
    process.stdout.write(`  Cordas: ${result.steps.length}\n`);
    process.stdout.write(`  Percurso da ferramenta: ${(totalLength / 1000).toFixed(2)} m\n`);
    process.stdout.write(`  Origem: ${origin ?? 'bottom-left'}\n`);
    process.stdout.write(`  Arquivo: ${outPath}\n\n`);
    return;
  }

  // Subcomando: estimate
  if (positionals[0] === 'estimate') {
    const jsonPath = positionals[1];
    if (!jsonPath) {
      process.stderr.write(
        'Erro: especifique o arquivo .weave.json. Uso: weaver-art estimate <projeto.weave.json> [opções]\n',
      );
      process.exit(1);
    }
    const raw = await readFile(jsonPath, 'utf8');
    const result = JSON.parse(raw) as WeaveResult;
    const secPerChord = num(values['sec-per-chord'], 'sec-per-chord');
    const spoolLength = num(values.spool, 'spool');
    const marginPct = num(values['spool-margin'] ?? values.margin, 'margin');

    const est = estimateWeave(result, {
      secondsPerChord: secPerChord,
      spoolLengthM: spoolLength,
      safetyMarginPct: marginPct,
    });

    process.stdout.write(`\nEstimativa de Fabricação / Tecelagem (${result.steps.length} cordas):\n`);
    process.stdout.write(`${'='.repeat(65)}\n`);
    process.stdout.write(`Tempo manual total estimado: ${formatDuration(est.totalSeconds)}\n`);
    process.stdout.write(
      `  - Tempo ativo tecendo:      ${formatDuration(est.weavingSeconds)} (${est.chords} cordas)\n`,
    );
    process.stdout.write(
      `  - Preparo e nós/trocas:      ${formatDuration(est.overheadSeconds)} (${est.tieOns} nós iniciais, ${est.switches} trocas)\n`,
    );
    if (est.machineSeconds !== undefined) {
      process.stdout.write(`Tempo estimado em máquina XY: ${formatDuration(est.machineSeconds)}\n`);
    }
    process.stdout.write(
      `\nConsumo de Fio por Cor (Carretel de ${spoolLength ?? 1000} m, margem ${marginPct ?? 10}%):\n`,
    );
    process.stdout.write(
      `${'Cor'.padEnd(12)} ${'Linhas'.padEnd(8)} ${'Comprimento'.padEnd(14)} ${'Com Margem'.padEnd(14)} ${'Carretéis'.padEnd(10)} Uso\n`,
    );
    process.stdout.write(`${'-'.repeat(65)}\n`);
    for (const t of est.threads) {
      const lenM = (t.lengthMm / 1000).toFixed(1) + ' m';
      const reqM = (t.requiredMm / 1000).toFixed(1) + ' m';
      process.stdout.write(
        `${t.name.padEnd(12)} ${String(t.lines).padEnd(8)} ${lenM.padEnd(14)} ${reqM.padEnd(14)} ${String(t.spools).padEnd(10)} ${t.spoolUsagePct.toFixed(1)}%\n`,
      );
    }
    process.stdout.write(`${'-'.repeat(65)}\n`);
    process.stdout.write(`Total de fio necessário: ${(est.totalRequiredMm / 1000).toFixed(1)} m\n\n`);
    return;
  }

  // Subcomando: extract-palette
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

  // Subcomando: calibrate-color
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

  // Fluxo principal de tecelagem
  const input = positionals[0];
  const presetName = values.preset as PresetName;
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`Preset desconhecido: ${values.preset}. Use: ${Object.keys(PRESETS).join(', ')}`);

  const fileConfig: DeepPartial<WeaveOptions> = values.config
    ? (JSON.parse(await readFile(values.config, 'utf8')) as DeepPartial<WeaveOptions>)
    : {};
  let options = resolveOptions(fileConfig, preset);

  const loom = await buildLoomConfig(values, (fileConfig.loom as LoomConfig) ?? preset.loom);
  const threadWidth = num(values['thread-width'], 'thread-width');
  options = resolveOptions(
    {
      loom,
      maxLines: num(values.lines, 'lines'),
      minPegGap: num(values.gap, 'gap'),
      maxChordRepeats: num(values.repeats, 'repeats'),
      resolutionPx: num(values.resolution, 'resolution'),
      background: values.background,
      colorStrategy: values['color-strategy'] as WeaveOptions['colorStrategy'],
      viewingDistanceM: num(values['viewing-distance'], 'viewing-distance'),
      highlightProtection: num(values['highlight-protection'], 'highlight-protection'),
      threads: threadWidth === undefined ? undefined : options.threads.map((t) => ({ ...t, widthMm: threadWidth })),
      preprocess: {
        contrast: num(values.contrast, 'contrast'),
        brightness: num(values.brightness, 'brightness'),
        gamma: num(values.gamma, 'gamma'),
        shadowLift: num(values['shadow-lift'], 'shadow-lift'),
        edgeEmphasis: num(values['edge-emphasis'], 'edge-emphasis'),
        highlightProtection: num(values['highlight-protection'], 'highlight-protection'),
        sharpenSigma: num(values['sharpen-sigma'], 'sharpen-sigma'),
        torsoFeathering: num(values['torso-feathering'], 'torso-feathering'),
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
      loomPegCount: loomPegCount(options.loom),
      threadWidthMm: threadWidth,
    });
    options.threads = autoPal.threads;
    options.threadLineBudgets = autoPal.threadLineBudgets;
    options.preprocess.grayscale = false;
  }
  const importance = values.importance ? await loadRaster(values.importance) : undefined;
  const accel = (values.accel as string | undefined) ?? 'wasm';

  let engine: WeaveEngine;
  if (accel === 'wasm') {
    engine = await WeaveEngine.createAsync(image, options, importance, {
      evaluator: async (setup: EvaluatorSetup) => {
        return instantiateWasmKernel(setup);
      },
    });
  } else {
    engine = new WeaveEngine(image, options, importance);
  }

  process.stderr.write(
    `${describeLoom(options.loom)} · grade ${options.resolutionPx}px · aceleração: ${accel} · ` +
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
  engine.dispose();

  const outDir = path.resolve(values.out);
  await mkdir(outDir, { recursive: true });
  const base = path.join(outDir, values.name ?? path.parse(input).name);
  const paper = (values.paper as PaperSize) ?? 'A4';
  const drillHole = num(values.drill, 'drill');
  const templateMargin = num(values.margin, 'margin');

  const filesToWrite: Promise<unknown>[] = [
    writeFile(`${base}.weave.json`, JSON.stringify(result)),
    writeFile(`${base}.weave.txt`, toInstructions(result, { estimate: true })),
    writeFile(`${base}.weave.csv`, toCSV(result)),
    writeFile(`${base}.weave.svg`, toSVG(result)),
    writePng(`${base}.weave.png`, engine.toRGBA(), engine.size),
    writePng(`${base}.target.png`, engine.targetToRGBA(), engine.size),
    writeFile(
      `${base}.template.svg`,
      toTemplateSVG(options.loom, { drillDiameterMm: drillHole, marginMm: templateMargin }),
      'utf8',
    ),
    writeFile(
      `${base}.template.pdf`,
      toTemplatePDF(options.loom, { paper, drillDiameterMm: drillHole, marginMm: templateMargin }),
    ),
    writeFile(`${base}.pegs.csv`, toPegsCSV(engine.loom), 'utf8'),
  ];

  if (values.gcode) {
    const clearance = num(values.clearance, 'clearance');
    const feed = num(values.feed, 'feed');
    const origin = values.origin as GcodeOptions['origin'];
    filesToWrite.push(
      writeFile(`${base}.weave.gcode`, toGcode(result, { clearanceMm: clearance, feedMmPerMin: feed, origin }), 'utf8'),
    );
  }

  await Promise.all(filesToWrite);

  const est = estimateWeave(result, {
    secondsPerChord: num(values['sec-per-chord'], 'sec-per-chord'),
    spoolLengthM: num(values.spool, 'spool'),
    safetyMarginPct: num(values['spool-margin'] ?? values.margin, 'margin'),
  });

  const reasons: Record<string, string> = {
    'max-lines': 'limite de linhas atingido',
    'no-improvement': 'nenhuma linha melhora mais o resultado',
    'no-candidates': 'sem cordas disponíveis',
    aborted: 'interrompido',
  };
  const deltaEStr = result.metrics?.deltaELab !== undefined ? ` · ΔE ${result.metrics.deltaELab.toFixed(2)}` : '';
  const ssimStr = result.metrics?.ssim !== undefined ? ` · SSIM ${result.metrics.ssim.toFixed(3)}` : '';
  const gcodeStr = values.gcode ? ',gcode' : '';
  process.stderr.write(
    [
      `✔ ${result.steps.length} linhas · ${(result.totalLengthMm / 1000).toFixed(2)} m de fio · RMSE ${result.rmse.toFixed(4)}${deltaEStr}${ssimStr}`,
      `  parada: ${reasons[result.stopReason]} · ${(result.durationMs / 1000).toFixed(1)} s`,
      `  tempo manual estimado: ${formatDuration(est.totalSeconds)} (${formatDuration(est.weavingSeconds)} tecendo + ${formatDuration(est.overheadSeconds)} nós/trocas)`,
      `  arquivos: ${base}.weave.{json,txt,csv,svg,png${gcodeStr}}, ${base}.template.{svg,pdf}, ${base}.pegs.csv`,
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`\nErro: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
