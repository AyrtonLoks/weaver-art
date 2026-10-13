import { tangentSegment } from './geometry.js';
import type { PegSide } from './types.js';
import type { WeaveEngine } from './engine.js';
import { ChordRasterizer } from './raster.js';

interface TouchedCoverage {
  covOld: number;
  covNew: number;
}

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
  const scale = engine.pxPerMm;
  const widthPxMax = Math.max(...options.threads.map((t) => t.widthMm * scale), 1);
  const raster = new ChordRasterizer(engine.size, widthPxMax);

  let totalImprovements = 0;

  // Search neighborhood around peg p_i (closest first)
  const deltaOffsets = [-1, 1, -2, 2, -3, 3];

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
      const widthPx = options.threads[t].widthMm * scale;
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

      // Rasterize old chords to know their current coverage on canvas
      const oldACount = raster.rasterize(
        oldSegA.x0 * scale,
        oldSegA.y0 * scale,
        oldSegA.x1 * scale,
        oldSegA.y1 * scale,
        widthPx,
      );
      const oldAIdx = new Int32Array(raster.idx.subarray(0, oldACount));
      const oldACov = new Float32Array(raster.cov.subarray(0, oldACount));

      const oldBCount = raster.rasterize(
        oldSegB.x0 * scale,
        oldSegB.y0 * scale,
        oldSegB.x1 * scale,
        oldSegB.y1 * scale,
        widthPx,
      );
      const oldBIdx = new Int32Array(raster.idx.subarray(0, oldBCount));
      const oldBCov = new Float32Array(raster.cov.subarray(0, oldBCount));

      // Build a map of old coverage per pixel: covOld = 1 - (1 - cA)(1 - cB)
      const touchedPixels = new Map<number, TouchedCoverage>();
      for (let k = 0; k < oldACount; k++) {
        const p = oldAIdx[k];
        touchedPixels.set(p, { covOld: oldACov[k] * op, covNew: 0 });
      }
      for (let k = 0; k < oldBCount; k++) {
        const p = oldBIdx[k];
        const existing = touchedPixels.get(p);
        const cB = oldBCov[k] * op;
        if (existing) {
          existing.covOld = 1 - (1 - existing.covOld) * (1 - cB);
        } else {
          touchedPixels.set(p, { covOld: cB, covNew: 0 });
        }
      }

      // Thread color in channels
      const threadColor = engine.getThreadColorChannels(t);

      let bestCand: {
        midPeg: number;
        midSide: PegSide;
        segA: typeof oldSegA;
        segB: typeof oldSegB;
        deltaError: number;
        touched: Map<number, TouchedCoverage>;
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

        // Test possible arrival/departure tangent side around the candidate intermediate peg.
        // Arrival and departure use the identical peg side to model continuous physical peg wrapping.
        for (const candSide of sides) {
          const candSegA = tangentSegment(pA, stepA.fromSide, pCandMid, candSide, pegRadiusMm);
          const candSegB = tangentSegment(pCandMid, candSide, pB, stepB.toSide, pegRadiusMm);

          // Rasterize candidate chords
          const candACount = raster.rasterize(
            candSegA.x0 * scale,
            candSegA.y0 * scale,
            candSegA.x1 * scale,
            candSegA.y1 * scale,
            widthPx,
          );
          const candAIdx = new Int32Array(raster.idx.subarray(0, candACount));
          const candACov = new Float32Array(raster.cov.subarray(0, candACount));

          const candBCount = raster.rasterize(
            candSegB.x0 * scale,
            candSegB.y0 * scale,
            candSegB.x1 * scale,
            candSegB.y1 * scale,
            widthPx,
          );
          const candBIdx = new Int32Array(raster.idx.subarray(0, candBCount));
          const candBCov = new Float32Array(raster.cov.subarray(0, candBCount));

          // Union touched pixels
          const candidateTouched = new Map<number, TouchedCoverage>();
          for (const [p, cov] of touchedPixels.entries()) {
            candidateTouched.set(p, { covOld: cov.covOld, covNew: 0 });
          }

          for (let k = 0; k < candACount; k++) {
            const p = candAIdx[k];
            const cA = candACov[k] * op;
            const existing = candidateTouched.get(p);
            if (existing) {
              existing.covNew = cA;
            } else {
              candidateTouched.set(p, { covOld: 0, covNew: cA });
            }
          }
          for (let k = 0; k < candBCount; k++) {
            const p = candBIdx[k];
            const cB = candBCov[k] * op;
            const existing = candidateTouched.get(p);
            if (existing) {
              existing.covNew = 1 - (1 - existing.covNew) * (1 - cB);
            } else {
              candidateTouched.set(p, { covOld: 0, covNew: cB });
            }
          }

          // Compute change in squared error across touched pixels
          let deltaError = 0;
          for (const [p, covs] of candidateTouched.entries()) {
            const w = target.weight[p];
            if (w === 0) continue;

            const cOld = covs.covOld;
            const cNew = covs.covNew;
            if (Math.abs(cOld - cNew) < 1e-6) continue;

            for (let ch = 0; ch < channels; ch++) {
              const q = p * channels + ch;
              const Tgt = target.data[q];
              const CanvasCurrent = engine.canvas[q];
              const K = threadColor[ch];

              // Unmix old coverage and apply candidate coverage
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
            bestCand = {
              midPeg: candMid,
              midSide: candSide,
              segA: candSegA,
              segB: candSegB,
              deltaError,
              touched: candidateTouched,
            };
          }
        }
      }

      if (bestCand) {
        // Apply pixel delta directly to engine canvas to keep state accurate for subsequent steps
        for (const [p, covs] of bestCand.touched.entries()) {
          const cOld = covs.covOld;
          const cNew = covs.covNew;
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

        // Accept the replacement
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
    }

    if (passImprovements === 0) break;
  }

  if (totalImprovements > 0) {
    // Re-render canvas from steps to guarantee 100% exact numerical fidelity
    engine.rebuildCanvasFromSteps();
  }

  return totalImprovements;
}
