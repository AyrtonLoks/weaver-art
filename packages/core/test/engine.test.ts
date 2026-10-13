import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTIONS,
  pegDistance,
  resolveOptions,
  toCSV,
  toInstructions,
  toSVG,
  WeaveEngine,
  type DeepPartial,
  type WeaveOptions,
} from '../src/index.js';
import { discImage, syntheticImage } from './fixtures.js';

const small: DeepPartial<WeaveOptions> = {
  resolutionPx: 160,
  maxLines: 150,
  loom: { pegCount: 120 },
  minPegGap: 8,
};

describe('options', () => {
  it('defaults follow the published Vrellis loom', () => {
    expect(DEFAULT_OPTIONS.loom.pegCount).toBe(200);
    expect(DEFAULT_OPTIONS.loom.diameterMm).toBeCloseTo(711.2, 6);
    expect(DEFAULT_OPTIONS.maxLines).toBe(4000);
  });

  it('rejects invalid configurations', () => {
    expect(() => resolveOptions({ loom: { pegCount: 2 } })).toThrow(/pegCount/);
    expect(() => resolveOptions({ loom: { pegDiameterMm: 20 } })).toThrow(/espaçamento/);
    expect(() => resolveOptions({ threads: [] })).toThrow(/fio/);
  });
});

describe('WeaveEngine', () => {
  it('reduces the error monotonically and respects loom constraints', () => {
    const engine = WeaveEngine.create(discImage(), small);
    const before = engine.rmse();
    const result = engine.run();
    expect(result.steps.length).toBeGreaterThan(20);
    expect(result.rmse).toBeLessThan(before);

    const N = result.options.loom.pegCount;
    const used = new Map<string, number>();
    result.steps.forEach((s, i) => {
      expect(s.gain).toBeGreaterThan(0);
      expect(pegDistance(s.from, s.to, N)).toBeGreaterThanOrEqual(result.options.minPegGap);
      if (i > 0) {
        // Single continuous thread: each chord starts where the previous ended, on the same side.
        expect(s.from).toBe(result.steps[i - 1].to);
        expect(s.fromSide).toBe(result.steps[i - 1].toSide);
      }
      const key = [Math.min(s.from, s.to), Math.max(s.from, s.to)].join('-');
      used.set(key, (used.get(key) ?? 0) + 1);
    });
    for (const count of used.values()) expect(count).toBeLessThanOrEqual(result.options.maxChordRepeats);
  });

  it('accounts for the full physical thread length (segments + wraps)', () => {
    const result = WeaveEngine.create(discImage(), small).run();
    const sum = result.steps.reduce((acc, s) => acc + s.segmentMm + s.wrapMm, 0);
    expect(result.totalLengthMm).toBeCloseTo(sum, 6);
    expect(result.steps.slice(1).every((s) => s.wrapMm > 0)).toBe(true);
    expect(result.threads[0].pegs).toHaveLength(result.steps.length + 1);
  });

  it('lays no thread on a blank (white) image', () => {
    const blank = syntheticImage(64, 64, () => 255);
    const result = WeaveEngine.create(blank, small).run();
    expect(result.steps).toHaveLength(0);
    expect(result.stopReason).toBe('no-improvement');
  });

  it('honours maxLines', () => {
    const result = WeaveEngine.create(discImage(), { ...small, maxLines: 10 }).run();
    expect(result.steps).toHaveLength(10);
    expect(result.stopReason).toBe('max-lines');
  });

  it('weaves several coloured threads, each continuous', () => {
    const image = syntheticImage(120, 120, (x) => (x < 60 ? 20 : 255));
    const result = WeaveEngine.create(image, {
      ...small,
      preprocess: { grayscale: false },
      threads: [
        { id: 'black', name: 'Preto', color: '#000000', widthMm: 0.3, opacity: 1, startPeg: 0 },
        { id: 'blue', name: 'Azul', color: '#1d3fbb', widthMm: 0.3, opacity: 1, startPeg: 60 },
      ],
    }).run();
    expect(result.threads).toHaveLength(2);
    for (let t = 0; t < 2; t++) {
      const steps = result.steps.filter((s) => s.thread === t);
      steps.slice(1).forEach((s, i) => expect(s.from).toBe(steps[i].to));
    }
  });
});

describe('exports', () => {
  const result = WeaveEngine.create(discImage(), { ...small, maxLines: 25 }).run();

  it('writes numbered instructions starting at peg 1', () => {
    const txt = toInstructions(result);
    expect(txt).toContain('INSTRUÇÕES');
    const first = result.steps[0];
    expect(txt).toContain(`${first.from + 1} → ${String(first.to + 1).padStart(3)}`);
  });

  it('writes CSV and real-scale SVG', () => {
    expect(toCSV(result).trim().split('\n')).toHaveLength(result.steps.length + 1);
    const svg = toSVG(result);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="751.2mm"');
    expect(svg).toContain('<path');
  });
});
