import { weaveFingerprint, type WeaveProgress, type WeaveResult } from '@weaver-art/core';

export interface StoredProjectRecord {
  fingerprint: string;
  result: WeaveResult;
  updatedAt: string;
}

export interface StoredProgressRecord {
  fingerprint: string;
  index: number;
  updatedAt: string;
}

const DB_NAME = 'weaver-art-db';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_PROGRESS = 'progress';

/**
 * Robust, zero-dependency IndexedDB persistence layer for Weaver Art knitting projects.
 * Persists full WeaveResult state and lightweight progress markers alongside localStorage.
 * Fully SSR/Node safe with graceful no-op fallbacks.
 */
export class PlayerStorage {
  private static dbPromise: Promise<IDBDatabase | null> | null = null;

  private static getDB(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;

    if (typeof window === 'undefined' || !window.indexedDB) {
      return Promise.resolve(null);
    }

    this.dbPromise = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
            db.createObjectStore(STORE_PROJECTS, { keyPath: 'fingerprint' });
          }
          if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
            db.createObjectStore(STORE_PROGRESS, { keyPath: 'fingerprint' });
          }
        };

        req.onsuccess = (e) => {
          resolve((e.target as IDBOpenDBRequest).result);
        };

        req.onerror = () => {
          resolve(null);
        };
      } catch {
        resolve(null);
      }
    });

    return this.dbPromise;
  }

  /**
   * Save the complete generated or imported WeaveResult project into IndexedDB.
   */
  static async saveProject(result: WeaveResult): Promise<boolean> {
    const db = await this.getDB();
    const fp = weaveFingerprint(result).toLowerCase();
    const record: StoredProjectRecord = {
      fingerprint: fp,
      result,
      updatedAt: new Date().toISOString(),
    };

    if (!db) {
      return false;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_PROJECTS, 'readwrite');
        const store = tx.objectStore(STORE_PROJECTS);
        const req = store.put(record);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Load a full WeaveResult project from IndexedDB by fingerprint.
   */
  static async loadProject(fingerprint: string): Promise<WeaveResult | null> {
    const db = await this.getDB();
    if (!db) return null;

    const fp = fingerprint.toLowerCase();

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_PROJECTS, 'readonly');
        const store = tx.objectStore(STORE_PROJECTS);
        const req = store.get(fp);
        req.onsuccess = () => {
          const record = req.result as StoredProjectRecord | undefined;
          resolve(record ? record.result : null);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Save step progress for a given project fingerprint into IndexedDB and localStorage.
   */
  static async saveProgress(fingerprint: string, index: number): Promise<boolean> {
    const fp = fingerprint.toLowerCase();
    const updatedAt = new Date().toISOString();

    // Fast localStorage pointer sync
    if (typeof localStorage !== 'undefined') {
      try {
        const data: WeaveProgress = { index, updatedAt };
        localStorage.setItem(`weaver-art:progress:${fp}`, JSON.stringify(data));
      } catch {
        // Ignore quota/private mode errors
      }
    }

    const db = await this.getDB();
    if (!db) return true;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_PROGRESS, 'readwrite');
        const store = tx.objectStore(STORE_PROGRESS);
        const req = store.put({ fingerprint: fp, index, updatedAt } satisfies StoredProgressRecord);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Load step progress for a given project fingerprint, trying IndexedDB first then localStorage.
   */
  static async loadProgress(fingerprint: string): Promise<{ index: number; updatedAt: string } | null> {
    const fp = fingerprint.toLowerCase();
    const db = await this.getDB();

    if (db) {
      const idbRecord = await new Promise<StoredProgressRecord | null>((resolve) => {
        try {
          const tx = db.transaction(STORE_PROGRESS, 'readonly');
          const store = tx.objectStore(STORE_PROGRESS);
          const req = store.get(fp);
          req.onsuccess = () => resolve((req.result as StoredProgressRecord) || null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });

      if (idbRecord && typeof idbRecord.index === 'number') {
        return { index: idbRecord.index, updatedAt: idbRecord.updatedAt };
      }
    }

    // Fallback to localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(`weaver-art:progress:${fp}`);
        if (raw) {
          const parsed = JSON.parse(raw) as WeaveProgress;
          if (parsed && typeof parsed.index === 'number') {
            return { index: parsed.index, updatedAt: parsed.updatedAt };
          }
        }
      } catch {
        // Fallback
      }
    }

    return null;
  }
}
