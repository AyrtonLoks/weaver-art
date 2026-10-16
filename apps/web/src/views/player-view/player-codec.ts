import {
  decodeProgressCode,
  encodeProgressCode,
  mergeProgress,
  weaveFingerprint,
  withProgress,
  type WeaveProgress,
  type WeaveResult,
} from '@weaver-art/core';
import { PlayerStorage } from './player-storage.js';

export interface DecodedProgressToken {
  fingerprint: string;
  index: number;
  spoolIdx?: number;
  format: 'core_v1' | 'cam_v1';
}

/**
 * Universal progress token and persistence codec for the weaving assistant.
 * Transparently interoperates between Core FNV-1a checksummed codes and CAM ProgressTokens,
 * while safely handling URL hash, IndexedDB, and localStorage synchronization.
 */
export class PlayerProgressCodec {
  /**
   * Universal token decoder supporting both:
   * 1. Core format: `WA1-<fingerprint>-<idx36>-<checksum>`
   * 2. CAM format:  `WA1-<project_hash>-<spool_idx>-<step_idx>`
   */
  static decode(input: string): DecodedProgressToken | null {
    if (!input) return null;
    let raw = input.trim();
    if (raw.startsWith('#progress=')) {
      raw = decodeURIComponent(raw.slice('#progress='.length));
    } else if (raw.startsWith('progress=')) {
      raw = decodeURIComponent(raw.slice('progress='.length));
    }

    // Attempt 1: Core format with checksum validation
    const coreDecoded = decodeProgressCode(raw);
    if (coreDecoded) {
      return {
        fingerprint: coreDecoded.fingerprint,
        index: coreDecoded.index,
        format: 'core_v1',
      };
    }

    // Attempt 2: CAM format (WA1-<hash>-<spool>-<step>)
    const parts = raw.split('-');
    if (parts.length === 4 && parts[0].toUpperCase() === 'WA1') {
      const hash = parts[1].toLowerCase();
      const spool = parseInt(parts[2], 10);
      const step = parseInt(parts[3], 10);
      if (!isNaN(step) && step >= 0) {
        return {
          fingerprint: hash,
          index: step,
          spoolIdx: isNaN(spool) ? undefined : spool,
          format: 'cam_v1',
        };
      }
    }

    return null;
  }

  /**
   * Encodes progress into the canonical Core checksummed token format.
   */
  static encode(result: WeaveResult, index: number): string {
    return encodeProgressCode(result, index);
  }

  /**
   * Safely updates browser URL hash using replaceState without polluting navigation history.
   */
  static syncUrlHash(code: string): void {
    if (typeof window === 'undefined') return;
    try {
      window.history.replaceState(null, '', `#progress=${encodeURIComponent(code)}`);
    } catch {
      // Ignore security errors in restricted iframe/sandbox environments
    }
  }

  /**
   * Reads initial step index from URL hash if matching the current project.
   */
  static readFromUrlHash(result: WeaveResult): number | null {
    if (typeof window === 'undefined') return null;
    const hash = window.location.hash;
    if (!hash.startsWith('#progress=')) return null;

    const token = this.decode(hash);
    if (!token) return null;

    const fp = weaveFingerprint(result).toLowerCase();
    if (token.fingerprint === fp || token.fingerprint.startsWith(fp.slice(0, 6))) {
      return token.index;
    }
    return null;
  }

  /**
   * Saves progress to both browser localStorage and asynchronous IndexedDB.
   */
  static saveProgress(fingerprint: string, index: number): void {
    this.saveToLocalStorage(fingerprint, index);
    PlayerStorage.saveProgress(fingerprint, index).catch(() => {});
  }

  /**
   * Saves progress to browser localStorage.
   */
  static saveToLocalStorage(fingerprint: string, index: number): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const data: WeaveProgress = {
        index,
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem(`weaver-art:progress:${fingerprint}`, JSON.stringify(data));
    } catch {
      // Local storage unavailable or quota exceeded
    }
  }

  /**
   * Loads saved progress from browser localStorage.
   */
  static loadFromLocalStorage(fingerprint: string): WeaveProgress | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(`weaver-art:progress:${fingerprint}`);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as WeaveProgress;
        if (parsed && typeof parsed.index === 'number') {
          return parsed;
        }
      } catch {
        const numVal = Number(raw);
        if (Number.isFinite(numVal)) {
          return { index: numVal, updatedAt: new Date(0).toISOString() };
        }
      }
    } catch {
      // Local storage inaccessible
    }
    return null;
  }

  /**
   * Saves full project state into IndexedDB.
   */
  static async saveProject(result: WeaveResult): Promise<boolean> {
    return PlayerStorage.saveProject(result);
  }

  /**
   * Loads full project state from IndexedDB by fingerprint.
   */
  static async loadProject(fingerprint: string): Promise<WeaveResult | null> {
    return PlayerStorage.loadProject(fingerprint);
  }

  /**
   * Resolves initial step by comparing URL hash, localStorage, and result metadata.
   */
  static resolveInitialStep(result: WeaveResult): number {
    const urlStep = this.readFromUrlHash(result);
    if (urlStep !== null) return urlStep;

    const fp = weaveFingerprint(result);
    const local = this.loadFromLocalStorage(fp);
    const merged = mergeProgress(local ?? undefined, result.progress);
    return merged?.index ?? 0;
  }

  /**
   * Downloads a `.weave.json` project file containing the current progress.
   */
  static exportResumeJson(result: WeaveResult, index: number): void {
    const updated = withProgress(result, index);
    const blob = new Blob([JSON.stringify(updated, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    if (typeof document !== 'undefined') {
      const a = document.createElement('a');
      a.href = url;
      a.download = `retomada-passo-${index + 1}.weave.json`;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
