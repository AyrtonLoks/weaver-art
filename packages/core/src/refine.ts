import { tangentSegment, type Segment } from './geometry.js';
import type { PegSide } from './types.js';
import type { WeaveEngine } from './engine.js';

/**
 * Post-greedy global refinement for Weaver Art.
 *
 * Iterates through intermediate pegs (p_{i-1} -> p_i -> p_{i+1}) within the same
 * thread layer and tests local perturbations p_i -> p_i'. If a perturbation strictly
 * reduces the global weighted residual error (while respecting peg spacing and repeat
 * limits), the intermediate peg is updated and the canvas is kept in sync.
 *
 * Crucially, thread continuity and physical pin wrapping (curr.fromSide === prev.toSide)
 * are strictly preserved across the entire artwork.
 *
 * @param engine The WeaveEngine instance with existing weave steps.
 * @param passes Number of full refinement sweeps (default: 1).
 * @returns Total number of peg replacements accepted.
 */
export function refineWeave(engine: WeaveEngine, passes = 1): number {
  if (passes <= 0 || engine.steps.length < 3) return 0;

  const { loom, target, options, channels } = engine;
  const { pegs, sides, pegRadiusMm } = loom;
  const N = pegs.length;

  let totalImprovements = 0;

  // Search neighborhood around peg p_i (closest first)
  const deltaOffsets = [-1, 1, -2, 2, -3, 3];

  // Scratch arrays to avoid per-candidate allocations
  const totalPixels = engine.size * engine.size;
  const covOldArr = new Float32Array(totalPixels);
  const covNewArr = new Float32Array(totalPixels);
  const touchedOld = new Int32Array(totalPixels);
  const touchedCand = new Int32Array(totalPixels);

  for (let pass = 0; pass < passes; pass++) {
    let passImprovements = 0;

    for (let i = 1; i < engine.steps.length; i++) {
      const stepA = engine.steps[i - 1];
      const stepB = engine.steps[i];

      // Must be the same thread and same layer to preserve physical continuous strand
      if (stepA.thread !== stepB.thread || stepA.layerIndex !== stepB.layerIndex) {
        continue;
      }

      const t = stepA.thread;
      const op = options.threads[t].opacity;
      const pegFrom = stepA.from;
      const pegMid = stepA.to; // = stepB.from
      const pegTo = stepB.to;

      // Ensure topological consistency
      if (stepB.from !== pegMid) continue;

      const pA = pegs[pegFrom];
      const pMid = pegs[pegMid];
      const pB = pegs[pegTo];

      // Current old segments
      const oldSegA = tangentSegment(pA, stepA.fromSide, pMid, stepA.toSide, pegRadiusMm);
      const oldSegB = tangentSegment(pMid, stepB.fromSide, pB, stepB.toSide, pegRadiusMm);

      const oldASamples = engine.chordSamples(pegFrom, stepA.fromSide, pegMid, stepA.toSide, t);
      const oldBSamples = engine.chordSamples(pegMid, stepB.fromSide, pegTo, stepB.toSide, t);

      let touchedOldCount = 0;
      for (let k = 0; k < oldASamples.count; k++) {
        const p = oldASamples.idx[k];
        const cA = oldASamples.cov[k] * op;
        if (covOldArr[p] === 0) {
          touchedOld[touchedOldCount++] = p;
          covOldArr[p] = cA;
        } else {
          covOldArr[p] = 1 - (1 - covOldArr[p]) * (1 - cA);
        }
      }
      for (let k = 0; k < oldBSamples.count; k++) {
        const p = oldBSamples.idx[k];
        const cB = oldBSamples.cov[k] * op;
        if (covOldArr[p] === 0) {
          touchedOld[touchedOldCount++] = p;
          covOldArr[p] = cB;
        } else {
          covOldArr[p] = 1 - (1 - covOldArr[p]) * (1 - cB);
        }
      }

      const threadColor = engine.getThreadColorChannels(t);

      let bestCand: {
        midPeg: number;
        midSide: PegSide;
        segA: Segment;
        segB: Segment;
        deltaError: number;
        pixels: Int32Array;
        covOld: Float32Array;
        covNew: Float32Array;
      } | null = null;

      // Temporarily decrement chord usage for the two old chords
      engine.decrementChordUse(pegFrom, pegMid);
      engine.decrementChordUse(pegMid, pegTo);

      for (const delta of deltaOffsets) {
        const candMid = (pegMid + delta + N) % N;
        if (candMid === pegMid) continue;
        if (engine.chordMask[pegFrom * N + candMid] === 0) continue;
        if (engine.chordMask[candMid * N + pegTo] === 0) continue;

        const neededUse = pegFrom === pegTo ? 2 : 1;
        if (engine.getChordUse(pegFrom, candMid) + neededUse > options.maxChordRepeats) continue;
        if (engine.getChordUse(candMid, pegTo) + neededUse > options.maxChordRepeats) continue;

        const pCandMid = pegs[candMid];

        for (const candSide of sides) {
          const candSegA = tangentSegment(pA, stepA.fromSide, pCandMid, candSide, pegRadiusMm);
          const candSegB = tangentSegment(pCandMid, candSide, pB, stepB.toSide, pegRadiusMm);

          const candASamples = engine.chordSamples(pegFrom, stepA.fromSide, candMid, candSide, t);
          const candBSamples = engine.chordSamples(candMid, candSide, pegTo, stepB.toSide, t);

          let touchedCandCount = 0;
          for (let k = 0; k < touchedOldCount; k++) {
            touchedCand[touchedCandCount++] = touchedOld[k];
          }

          for (let k = 0; k < candASamples.count; k++) {
            const p = candASamples.idx[k];
            const cA = candASamples.cov[k] * op;
            if (covNewArr[p] === 0) {
              if (covOldArr[p] === 0) {
                touchedCand[touchedCandCount++] = p;
              }
              covNewArr[p] = cA;
            } else {
              covNewArr[p] = 1 - (1 - covNewArr[p]) * (1 - cA);
            }
          }

          for (let k = 0; k < candBSamples.count; k++) {
            const p = candBSamples.idx[k];
            const cB = candBSamples.cov[k] * op;
            if (covNewArr[p] === 0) {
              if (covOldArr[p] === 0) {
                touchedCand[touchedCandCount++] = p;
              }
              covNewArr[p] = cB;
            } else {
              covNewArr[p] = 1 - (1 - covNewArr[p]) * (1 - cB);
            }
          }

          let deltaError = 0;
          for (let k = 0; k < touchedCandCount; k++) {
            const p = touchedCand[k];
            const w = target.weight[p];
            if (w === 0) continue;

            const cOld = covOldArr[p];
            const cNew = covNewArr[p];
            if (Math.abs(cOld - cNew) < 1e-6) continue;

            for (let ch = 0; ch < channels; ch++) {
              const q = p * channels + ch;
              const Tgt = target.data[q];
              const CanvasCurrent = engine.canvas[q];
              const K = threadColor[ch];

              const denom = Math.max(1e-4, 1 - cOld);
              const base = Math.min(1, Math.max(0, (CanvasCurrent - cOld * K) / denom));
              const canvasNew = Math.min(1, Math.max(0, base + cNew * (K - base)));

              const errOld = Tgt - CanvasCurrent;
              const errNew = Tgt - canvasNew;
              deltaError += w * (errNew * errNew - errOld * errOld);
            }
          }

          // Length penalty adjustment if active
          if (options.lengthPenalty && options.lengthPenalty > 0) {
            const oldLen = oldSegA.length + oldSegB.length;
            const newLen = candSegA.length + candSegB.length;
            const dLenNorm = (newLen - oldLen) / loom.extentMm;
            deltaError += options.lengthPenalty * dLenNorm;
          }

          if (deltaError < -1e-5 && (!bestCand || deltaError < bestCand.deltaError)) {
            const pixelsSnapshot = new Int32Array(touchedCandCount);
            const covOldSnapshot = new Float32Array(touchedCandCount);
            const covNewSnapshot = new Float32Array(touchedCandCount);
            for (let k = 0; k < touchedCandCount; k++) {
              const p = touchedCand[k];
              pixelsSnapshot[k] = p;
              covOldSnapshot[k] = covOldArr[p];
              covNewSnapshot[k] = covNewArr[p];
            }
            bestCand = {
              midPeg: candMid,
              midSide: candSide,
              segA: candSegA,
              segB: candSegB,
              deltaError,
              pixels: pixelsSnapshot,
              covOld: covOldSnapshot,
              covNew: covNewSnapshot,
            };
          }

          // Reset covNewArr for next candidate
          for (let k = 0; k < touchedCandCount; k++) {
            covNewArr[touchedCand[k]] = 0;
          }
        }
      }

      if (bestCand) {
        // Apply pixel delta directly to engine canvas
        for (let k = 0; k < bestCand.pixels.length; k++) {
          const p = bestCand.pixels[k];
          const cOld = bestCand.covOld[k];
          const cNew = bestCand.covNew[k];
          if (Math.abs(cOld - cNew) < 1e-6) continue;
          for (let ch = 0; ch < channels; ch++) {
            const q = p * channels + ch;
            const CanvasCurrent = engine.canvas[q];
            const K = threadColor[ch];
            const denom = Math.max(1e-4, 1 - cOld);
            const base = Math.min(1, Math.max(0, (CanvasCurrent - cOld * K) / denom));
            engine.canvas[q] = Math.min(1, Math.max(0, base + cNew * (K - base)));
          }
        }

        stepA.to = bestCand.midPeg;
        stepA.toSide = bestCand.midSide;
        stepA.segmentMm = bestCand.segA.length;

        stepB.from = bestCand.midPeg;
        stepB.fromSide = bestCand.midSide;
        stepB.segmentMm = bestCand.segB.length;

        engine.incrementChordUse(pegFrom, bestCand.midPeg);
        engine.incrementChordUse(bestCand.midPeg, pegTo);

        passImprovements++;
        totalImprovements++;
      } else {
        // Restore chord usage for old chords
        engine.incrementChordUse(pegFrom, pegMid);
        engine.incrementChordUse(pegMid, pegTo);
      }

      // Reset covOldArr
      for (let k = 0; k < touchedOldCount; k++) {
        covOldArr[touchedOld[k]] = 0;
      }
    }

    if (passImprovements === 0) break;
  }

  if (totalImprovements > 0) {
    // Re-render canvas from steps to guarantee 100% exact numerical fidelity
    engine.rebuildCanvasFromSteps();
  }

  return totalImprovements;
}
