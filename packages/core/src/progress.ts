import { loomPegCount } from './geometry.js';
import type { WeaveProgress, WeaveResult } from './types.js';

/**
 * Compute a stable FNV-1a fingerprint hash for a WeaveResult.
 * Guaranteed backwards compatible with v0.3 localStorage keys for circular looms.
 */
export function weaveFingerprint(r: WeaveResult): string {
  let h = 2166136261;
  const feed = (n: number): void => {
    h ^= n;
    h = Math.imul(h, 16777619);
  };
  feed(r.steps.length);
  feed(loomPegCount(r.options.loom));
  for (const s of r.steps) {
    feed(s.from);
    feed(s.to);
    feed(s.thread);
  }
  return (h >>> 0).toString(36);
}

function progressChecksum(fp: string, idxStr: string): string {
  let h = 2166136261;
  const s = `${fp}:${idxStr}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1296).toString(36).padStart(2, '0');
}

/**
 * Encode current knitting step into a compact shareable progress code:
 * Format: `WA1-<fingerprint>-<idx36>-<checksum>` (e.g. `WA1-k3x9q2-1f4-7a`).
 */
export function encodeProgressCode(result: WeaveResult, index: number): string {
  const fp = weaveFingerprint(result);
  const idxStr = Math.max(0, Math.floor(index)).toString(36);
  const chk = progressChecksum(fp, idxStr);
  return `WA1-${fp}-${idxStr}-${chk}`;
}

/**
 * Decode and validate a progress code. Returns null if invalid or corrupted.
 */
export function decodeProgressCode(code: string): { fingerprint: string; index: number } | null {
  const match = code.trim().match(/^WA1-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)$/i);
  if (!match) return null;
  const fp = match[1].toLowerCase();
  const idxStr = match[2].toLowerCase();
  const chk = match[3].toLowerCase();

  if (progressChecksum(fp, idxStr) !== chk) {
    return null; // Checksum mismatch (typo protection)
  }

  const index = parseInt(idxStr, 36);
  if (!Number.isFinite(index) || index < 0) return null;
  return { fingerprint: fp, index };
}

/**
 * Attach or update the progress metadata on a WeaveResult.
 */
export function withProgress(result: WeaveResult, index: number, now = new Date()): WeaveResult {
  return {
    ...result,
    progress: {
      index: Math.max(0, Math.floor(index)),
      updatedAt: now.toISOString(),
    },
  };
}

/**
 * Merge two progress states, selecting the most recently updated one.
 */
export function mergeProgress(local?: WeaveProgress, remote?: WeaveProgress): WeaveProgress | undefined {
  if (!local) return remote;
  if (!remote) return local;

  const timeL = new Date(local.updatedAt).getTime();
  const timeR = new Date(remote.updatedAt).getTime();

  if (Number.isNaN(timeL)) return remote;
  if (Number.isNaN(timeR)) return local;

  return timeR >= timeL ? remote : local;
}
