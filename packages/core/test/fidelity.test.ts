import { describe, expect, it } from 'vitest';
import {
  computeMultiscaleSaliency,
  computeSobelEdgeMagnitude,
  computeUnsharpMask,
  prepareTarget,
  PRESETS,
  resolveOptions,
  WeaveEngine,
  JsEvaluator,
  type EvaluatorSetup,
  createLoom,
  buildChordMask,
} from '../src/index.js';
import { discImage, syntheticImage } from './fixtures.js';

describe('Petros Vrellis Portrait Fidelity Features', () => {
  describe('Unsharp Mask & Multiscale Saliency', () => {
    it('computeUnsharpMask reinforces local contrast around edges', () => {
      // 10x10 image with a step edge at x = 5 (left = 0.2, right = 0.8)
      const size = 10;
      const data = new Float32Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          data[y * size + x] = x < 5 ? 0.2 : 0.8;
        }
      }

      const sharpened = computeUnsharpMask(data, size, size, 1, 1.0, 1.0);

      // Edge overshoot: pixel immediately left of edge (x=4) should be darker than 0.2
      // pixel immediately right of edge (x=5) should be brighter than 0.8
      expect(sharpened[4 * size + 4]).toBeLessThan(0.2);
      expect(sharpened[4 * size + 5]).toBeGreaterThan(0.8);
    });

    it('computeMultiscaleSaliency boosts fine high frequencies non-linearly', () => {
      const size = 32;
      const luma = new Float32Array(size * size);
      // Subtle line of 1 pixel width (modeling subtle eyebrow or eyelash feature)
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          luma[y * size + x] = x === 16 ? 0.75 : 0.85;
        }
      }

      const linearEdges = computeSobelEdgeMagnitude(luma, size);
      const multiSaliency = computeMultiscaleSaliency(luma, size, 0.7);

      const edgeIdx = 16 * size + 15;
      expect(linearEdges[edgeIdx]).toBeGreaterThan(0);
      // Because gamma < 1 (0.7), the relative response on fine subtle structures is expanded
      expect(multiSaliency[edgeIdx]).toBeGreaterThan(linearEdges[edgeIdx]);
    });

    it('torsoFeathering smooths weights near bottom edge to prevent black hole artifacts', () => {
      const img = syntheticImage(64, 64, () => 50);
      const targetUnfeathered = prepareTarget(
        img,
        64,
        {
          grayscale: true,
          contrast: 1,
          brightness: 0,
          gamma: 1,
          invert: false,
          torsoFeathering: 0,
        },
        1,
      );

      const targetFeathered = prepareTarget(
        img,
        64,
        {
          grayscale: true,
          contrast: 1,
          brightness: 0,
          gamma: 1,
          invert: false,
          torsoFeathering: 0.25,
        },
        1,
      );

      // Top row (y = 10, inside loom): weights should be identical
      const topIdx = 10 * 64 + 32;
      expect(targetFeathered.weight[topIdx]).toBeCloseTo(targetUnfeathered.weight[topIdx], 4);

      // Bottom row near the rim (y = 60, x = 32): feathered weight should be significantly lower
      const bottomIdx = 60 * 64 + 32;
      expect(targetFeathered.weight[bottomIdx]).toBeLessThan(targetUnfeathered.weight[bottomIdx] * 0.5);
    });
  });

  describe('Evaluator Penalties: Highlight Protection, Angular Diversity, Center Damping', () => {
    function setupEvaluator(opts: {
      highlightProtection?: number;
      angularDiversity?: number;
      centerDampRadiusMm?: number;
    }): { evaluator: JsEvaluator; setup: EvaluatorSetup; loom: ReturnType<typeof createLoom> } {
      const loom = createLoom({
        shape: 'circle',
        diameterMm: 200,
        pegCount: 20,
        pegDiameterMm: 2,
        startAngleDeg: 0,
      });
      const N = loom.pegs.length;
      const size = 64;
      const pxPerMm = size / loom.extentMm;
      const chordMask = buildChordMask(loom, 2);

      const pegX = new Float64Array(N);
      const pegY = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        pegX[i] = loom.pegs[i].x;
        pegY[i] = loom.pegs[i].y;
      }

      const setup: EvaluatorSetup = {
        size,
        channels: 1,
        scale: pxPerMm,
        extentMm: loom.extentMm,
        pegX,
        pegY,
        pegRadiusMm: loom.pegRadiusMm,
        sides: loom.sides,
        chordMask,
        threadColors: new Float32Array([0]), // Black thread
        threadWidthPx: new Float32Array([1.5]),
        threadOpacity: new Float32Array([1.0]),
        maxChordRepeats: 2,
        rasterCacheBytes: 1024 * 1024,
        highlightProtection: opts.highlightProtection ?? 0,
        angularDiversity: opts.angularDiversity ?? 0,
        centerDampRadiusMm: opts.centerDampRadiusMm ?? 0,
      };

      const evaluator = new JsEvaluator(setup);
      return { evaluator, setup, loom };
    }

    it('highlightProtection penalizes over-darkening of light skin / highlight pixels', () => {
      const { evaluator: evalNormal, loom } = setupEvaluator({ highlightProtection: 0 });
      const { evaluator: evalProtected } = setupEvaluator({ highlightProtection: 3.5 });

      // Target is bright white (0.95), canvas is already at target (0.95)
      // Drawing a black thread over it causes term < 0 (over-darkening highlights)
      evalNormal.buffers.target.fill(0.95);
      evalNormal.buffers.canvas.fill(0.95);
      evalNormal.buffers.weight.fill(1.0);

      evalProtected.buffers.target.fill(0.95);
      evalProtected.buffers.canvas.fill(0.95);
      evalProtected.buffers.weight.fill(1.0);

      // Score chord from peg 0 to peg 10 (horizontal diameter chord across the middle)
      const q = { thread: 0, fromPeg: 0, fromSide: loom.sides[0] };
      const gainNormal = evalNormal.scoreChord(q, 10, loom.sides[0]);
      const gainProtected = evalProtected.scoreChord(q, 10, loom.sides[0]);

      // Both should be negative because it over-darkens a white canvas
      expect(gainNormal).toBeLessThan(0);
      expect(gainProtected).toBeLessThan(0);

      // But gainProtected must be significantly more negative (penalized ~4.5x)
      expect(gainProtected).toBeLessThan(gainNormal * 3.0);
    });

    it('angularDiversity discounts consecutive chords with similar orientation (< 15 deg)', () => {
      const { evaluator, loom } = setupEvaluator({ angularDiversity: 0.4 });
      evaluator.buffers.target.fill(0.1); // dark target so gain > 0
      evaluator.buffers.canvas.fill(1.0); // white canvas
      evaluator.buffers.weight.fill(1.0);

      // Chord from peg 0 (at angle 0, x=100, y=0) to peg 10 (at angle PI, x=-100, y=0) is horizontal (dx = -1, dy = 0)
      // Suppose lastDir was horizontal (dx = -1, dy = 0)
      const qParallel = {
        thread: 0,
        fromPeg: 0,
        fromSide: loom.sides[0],
        lastDirX: -1,
        lastDirY: 0,
      };
      // Suppose lastDir was orthogonal (dx = 0, dy = 1)
      const qOrthogonal = {
        thread: 0,
        fromPeg: 0,
        fromSide: loom.sides[0],
        lastDirX: 0,
        lastDirY: 1,
      };

      const gainParallel = evaluator.scoreChord(qParallel, 10, loom.sides[0]);
      const gainOrthogonal = evaluator.scoreChord(qOrthogonal, 10, loom.sides[0]);

      expect(gainParallel).toBeGreaterThan(0);
      expect(gainOrthogonal).toBeGreaterThan(0);

      // Parallel chord should receive ~40% discount compared to orthogonal chord
      expect(gainParallel).toBeCloseTo(gainOrthogonal * (1 - 0.4), 1);
    });

    it('centerDampRadiusMm attenuates chords passing right through loom center', () => {
      const { evaluator: evalNormal, loom } = setupEvaluator({ centerDampRadiusMm: 0 });
      const { evaluator: evalDamped } = setupEvaluator({ centerDampRadiusMm: 30 });

      evalNormal.buffers.target.fill(0.1);
      evalNormal.buffers.canvas.fill(1.0);
      evalNormal.buffers.weight.fill(1.0);

      evalDamped.buffers.target.fill(0.1);
      evalDamped.buffers.canvas.fill(1.0);
      evalDamped.buffers.weight.fill(1.0);

      // Peg 0 to peg 10 passes exactly through center (0, 0), dCenter = 0
      const q = { thread: 0, fromPeg: 0, fromSide: loom.sides[0] };
      const gainNormal = evalNormal.scoreChord(q, 10, loom.sides[0]);
      const gainDamped = evalDamped.scoreChord(q, 10, loom.sides[0]);

      expect(gainNormal).toBeGreaterThan(0);
      // When dCenter = 0, gain is attenuated by factor 0.75 + 0.25 * 0 = 0.75
      expect(gainDamped).toBeCloseTo(gainNormal * 0.75, 2);
    });
  });

  describe('Presets portrait-mono & portrait-cmyk', () => {
    it('defines portrait presets with correct parameters in PRESETS', () => {
      const mono = PRESETS['portrait-mono'];
      expect(mono.resolutionPx).toBe(500);
      expect(mono.maxLines).toBe(4000);
      expect(mono.maxChordRepeats).toBe(2);
      expect(mono.preprocess.clahe).toBe(true);
      expect(mono.preprocess.edgeEmphasis).toBe(0.8);
      expect(mono.preprocess.highlightProtection).toBe(2.5);
      expect(mono.preprocess.angularDiversity).toBe(0.35);
      expect(mono.preprocess.shadowLift).toBe(0.12);

      const cmyk = PRESETS['portrait-cmyk'];
      expect(cmyk.resolutionPx).toBe(500);
      expect(cmyk.maxLines).toBe(6000);
      expect(cmyk.maxChordRepeats).toBe(2);
      expect(cmyk.threadLineBudgets).toEqual([0.3, 0.05, 0.25, 0.4]);
      expect(cmyk.preprocess.highlightProtection).toBe(2.5);
    });

    it('resolves options and runs portrait-mono with monotonic error reduction', () => {
      const img = discImage(100);
      const opts = resolveOptions(
        {
          resolutionPx: 80,
          maxLines: 15,
        },
        PRESETS['portrait-mono'],
      );

      const engine = WeaveEngine.create(img, opts);
      const initialRmse = engine.rmse();
      const res = engine.run();

      expect(res.steps.length).toBe(15);
      expect(res.rmse).toBeLessThan(initialRmse);
    });
  });
});
