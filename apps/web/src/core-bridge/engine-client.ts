/**
 * Main Thread Engine Client for the Weaver Art Wasm Solver (Sprint 3 / Task 3.3).
 *
 * Encapsulates worker lifecycle, SharedWorkspaceMemory atomic synchronization,
 * message protocol, and CAM export requests.
 */

import {
  SharedWorkspaceMemory,
  type TelemetryMetricsSnapshot,
  type MutableWeavingStepRecord,
} from './shared-memory-layout.js';
import {
  SolverStatusFlag,
  type WeaverConfig,
  type WeavingStepRecord,
  type SolverStatusFlagValue,
} from '../domain-contracts/types.js';
import type { CamExportType, FromSolverWorkerMessage, ToSolverWorkerMessage } from './solver.worker.js';

export interface EngineClientOptions {
  capacitySteps?: number;
  forceFallback?: boolean;
  workerUrl?: URL | string;
}

export interface PreparedImageResult {
  summaryJson: string;
  preparedRgba: ArrayBuffer;
  importanceRgba: ArrayBuffer;
  edgesRgba: ArrayBuffer;
  radonRgba: ArrayBuffer;
  dimensions: number[];
}

export interface ProgressNotification {
  currentStep: number;
  rmse: number;
  deltaE: number;
  ssim: number;
  totalThreadMeters: number;
}

export interface SmartFramingResult {
  zoom: number;
  panXPercent: number;
  panYPercent: number;
  confidence: number;
}

/**
 * High-performance client that bridges the UI thread to the background Wasm solver worker.
 */
export class WeaverEngineClient {
  public readonly memory: SharedWorkspaceMemory;
  private worker: Worker | null = null;
  private isInitialized = false;
  private wasmReady = false;

  private onProgressCallbacks: Set<(progress: ProgressNotification) => void> = new Set();
  private onDoneCallbacks: Set<(done: ProgressNotification) => void> = new Set();
  private onPausedCallbacks: Set<(step: number) => void> = new Set();
  private onErrorCallbacks: Set<(err: string) => void> = new Set();

  private pendingCamExports: Map<
    string,
    { resolve: (res: string | Uint8Array) => void; reject: (err: unknown) => void }
  > = new Map();
  private pendingImagePrepare: { resolve: (res: PreparedImageResult) => void; reject: (err: unknown) => void } | null =
    null;
  private pendingSolverInit: { resolve: () => void; reject: (err: unknown) => void } | null = null;
  private pendingBrushApply: { resolve: (buf: ArrayBuffer) => void; reject: (err: unknown) => void } | null = null;
  private pendingSmartFrame: { resolve: (res: SmartFramingResult) => void; reject: (err: unknown) => void } | null =
    null;

  constructor(options?: EngineClientOptions) {
    this.memory = new SharedWorkspaceMemory(options?.capacitySteps, {
      forceFallback: options?.forceFallback,
    });
  }

  /**
   * Initializes the Web Worker and connects the SharedArrayBuffer memory.
   */
  public async init(workerOverride?: Worker): Promise<void> {
    if (this.isInitialized) return;

    return new Promise((resolve, reject) => {
      try {
        if (workerOverride) {
          this.worker = workerOverride;
        } else if (typeof Worker !== 'undefined') {
          this.worker = new Worker(new URL('./solver.worker.ts', import.meta.url), {
            type: 'module',
          });
        } else {
          // Ambiente sem Worker (ex: testes em Node)
          this.isInitialized = true;
          this.wasmReady = false;
          resolve();
          return;
        }

        const timeout = setTimeout(() => {
          reject(
            new Error(
              "Timeout ao inicializar o Wasm solver worker. Verifique se o módulo Wasm foi compilado via 'npm run build:wasm'.",
            ),
          );
        }, 8000);

        this.worker.onmessage = (e: MessageEvent<FromSolverWorkerMessage>) => {
          const msg = e.data;
          switch (msg.type) {
            case 'READY':
              clearTimeout(timeout);
              this.isInitialized = true;
              this.wasmReady = true;
              resolve();
              break;

            case 'IMAGE_PREPARED':
              if (this.pendingImagePrepare) {
                this.pendingImagePrepare.resolve({
                  summaryJson: msg.summaryJson,
                  preparedRgba: msg.preparedRgba,
                  importanceRgba: msg.importanceRgba,
                  edgesRgba: msg.edgesRgba,
                  radonRgba: msg.radonRgba,
                  dimensions: msg.dimensions,
                });
                this.pendingImagePrepare = null;
              }
              break;

            case 'BRUSH_APPLIED':
              if (this.pendingBrushApply) {
                this.pendingBrushApply.resolve(msg.importanceRgba);
                this.pendingBrushApply = null;
              }
              break;

            case 'SOLVER_INITIALIZED':
              if (this.pendingSolverInit) {
                this.pendingSolverInit.resolve();
                this.pendingSolverInit = null;
              }
              break;

            case 'PROGRESS':
              for (const cb of this.onProgressCallbacks) {
                cb({
                  currentStep: msg.currentStep,
                  rmse: msg.rmse,
                  deltaE: msg.deltaE,
                  ssim: msg.ssim,
                  totalThreadMeters: msg.totalThreadMeters,
                });
              }
              break;

            case 'PAUSED':
              for (const cb of this.onPausedCallbacks) {
                cb(msg.currentStep);
              }
              break;

            case 'DONE':
              for (const cb of this.onDoneCallbacks) {
                cb({
                  currentStep: msg.currentStep,
                  rmse: msg.rmse,
                  deltaE: msg.deltaE,
                  ssim: msg.ssim,
                  totalThreadMeters: msg.totalThreadMeters,
                });
              }
              break;

            case 'CAM_EXPORT_RESULT': {
              const pending = this.pendingCamExports.get(msg.exportId);
              if (pending) {
                pending.resolve(msg.result);
                this.pendingCamExports.delete(msg.exportId);
              }
              break;
            }

            case 'SMART_FRAME_RESULT':
              if (this.pendingSmartFrame) {
                try {
                  const parsed = JSON.parse(msg.resultJson) as SmartFramingResult;
                  this.pendingSmartFrame.resolve(parsed);
                } catch (err) {
                  this.pendingSmartFrame.reject(err);
                }
                this.pendingSmartFrame = null;
              }
              break;

            case 'ERROR':
              if (this.pendingImagePrepare) {
                this.pendingImagePrepare.reject(new Error(msg.message));
                this.pendingImagePrepare = null;
              }
              if (this.pendingSolverInit) {
                this.pendingSolverInit.reject(new Error(msg.message));
                this.pendingSolverInit = null;
              }
              if (this.pendingSmartFrame) {
                this.pendingSmartFrame.reject(new Error(msg.message));
                this.pendingSmartFrame = null;
              }
              for (const cb of this.onErrorCallbacks) {
                cb(msg.message);
              }
              if (msg.fatal) {
                clearTimeout(timeout);
                reject(new Error(msg.message));
              }
              break;
          }
        };

        this.worker.onerror = (err) => {
          clearTimeout(timeout);
          const message = err.message || 'Erro desconhecido no Web Worker';
          for (const cb of this.onErrorCallbacks) {
            cb(message);
          }
          reject(new Error(`Worker error: ${message}`));
        };

        // Dispara mensagem inicial de conexão
        const initMsg: ToSolverWorkerMessage = {
          type: 'INIT',
          buffer: this.memory.buffer,
          capacitySteps: this.memory.capacitySteps,
        };
        this.worker.postMessage(initMsg);
      } catch (err) {
        reject(
          new Error(
            `Falha ao iniciar WeaverEngineClient: ${err instanceof Error ? err.message : String(err)}. Verifique se 'npm run build:wasm' foi executado.`,
          ),
        );
      }
    });
  }

  /** Checks whether the Wasm solver module is ready to execute. */
  public isReady(): boolean {
    return this.isInitialized && this.wasmReady;
  }

  /**
   * Executes the complete DSP pipeline on the input RGBA image in the background.
   */
  public async loadAndPrepareImage(
    rawRgba: Uint8Array | ArrayBuffer,
    width: number,
    height: number,
    config: WeaverConfig | string,
  ): Promise<PreparedImageResult> {
    if (!this.worker) {
      throw new Error("Worker não inicializado. Chame 'await client.init()' primeiro.");
    }

    const configJson = typeof config === 'string' ? config : JSON.stringify(config);
    let rawBuffer: ArrayBuffer;
    if (rawRgba instanceof Uint8Array) {
      rawBuffer = new ArrayBuffer(rawRgba.byteLength);
      new Uint8Array(rawBuffer).set(rawRgba);
    } else if (rawRgba instanceof ArrayBuffer) {
      rawBuffer = rawRgba;
    } else {
      const u8 = new Uint8Array(rawRgba);
      rawBuffer = new ArrayBuffer(u8.byteLength);
      new Uint8Array(rawBuffer).set(u8);
    }

    return new Promise((resolve, reject) => {
      this.pendingImagePrepare = { resolve, reject };
      const msg: ToSolverWorkerMessage = {
        type: 'LOAD_AND_PREPARE_IMAGE',
        rawRgba: rawBuffer,
        width,
        height,
        configJson,
      };
      this.worker!.postMessage(msg, [rawBuffer]);
    });
  }

  /**
   * Updates the facial importance mask using manual brush weights without upstream DSP re-computation.
   */
  public async applyImportanceBrush(brushWeights: Float32Array): Promise<ArrayBuffer> {
    if (!this.worker) {
      throw new Error("Worker não inicializado. Chame 'await client.init()' primeiro.");
    }

    return new Promise((resolve, reject) => {
      this.pendingBrushApply = { resolve, reject };
      const msg: ToSolverWorkerMessage = {
        type: 'APPLY_BRUSH',
        brushWeights,
      };
      this.worker!.postMessage(msg);
    });
  }

  /**
   * Computes automatic facial saliency framing (zoom, panXPercent, panYPercent) via the Rust Wasm DSP engine.
   */
  public async computeSmartFraming(
    rawRgba: Uint8Array | ArrayBuffer,
    width: number,
    height: number,
    targetRatio = 0.8,
  ): Promise<SmartFramingResult> {
    if (!this.worker) {
      throw new Error("Worker não inicializado. Chame 'await client.init()' primeiro.");
    }

    let rawBuffer: ArrayBuffer;
    if (rawRgba instanceof Uint8Array) {
      rawBuffer = new ArrayBuffer(rawRgba.byteLength);
      new Uint8Array(rawBuffer).set(rawRgba);
    } else if (rawRgba instanceof ArrayBuffer) {
      rawBuffer = rawRgba.slice(0);
    } else {
      const u8 = new Uint8Array(rawRgba);
      rawBuffer = new ArrayBuffer(u8.byteLength);
      new Uint8Array(rawBuffer).set(u8);
    }

    return new Promise((resolve, reject) => {
      this.pendingSmartFrame = { resolve, reject };
      const msg: ToSolverWorkerMessage = {
        type: 'SMART_FRAME',
        rawRgba: rawBuffer,
        width,
        height,
        targetRatio,
      };
      this.worker!.postMessage(msg, [rawBuffer]);
    });
  }

  /**
   * Initializes the solver session and SparseChordMatrixCSR with the given configuration.
   */
  public async initSolver(config: WeaverConfig | string): Promise<void> {
    if (!this.worker) {
      throw new Error("Worker não inicializado. Chame 'await client.init()' primeiro.");
    }

    const configJson = typeof config === 'string' ? config : JSON.stringify(config);
    return new Promise((resolve, reject) => {
      this.pendingSolverInit = { resolve, reject };
      const msg: ToSolverWorkerMessage = {
        type: 'INIT_SOLVER',
        configJson,
      };
      this.worker!.postMessage(msg);
    });
  }

  /** Starts or resumes the iterative solving batch loop in the worker. */
  public startSolver(batchSize = 50): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'START', batchSize });
  }

  /** Pauses the solver execution between batches. */
  public pauseSolver(): void {
    if (!this.worker) return;
    this.memory.setStatus(SolverStatusFlag.PAUSED);
    this.worker.postMessage({ type: 'PAUSE' });
  }

  /** Permanently aborts the solver execution. */
  public abortSolver(): void {
    if (!this.worker) return;
    this.memory.setStatus(SolverStatusFlag.ABORT);
    this.worker.postMessage({ type: 'ABORT' });
  }

  /** Requests an on-demand CAM export artifact from the background engine. */
  public async exportCam(type: CamExportType, config?: WeaverConfig | string): Promise<string | Uint8Array> {
    if (!this.worker) {
      throw new Error("Worker não inicializado. Chame 'await client.init()' primeiro.");
    }

    const exportId = `cam_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const configJson = config ? (typeof config === 'string' ? config : JSON.stringify(config)) : undefined;

    return new Promise((resolve, reject) => {
      this.pendingCamExports.set(exportId, { resolve, reject });
      const msg: ToSolverWorkerMessage = {
        type: 'EXPORT_CAM',
        camType: type,
        exportId,
        configJson,
      };
      this.worker!.postMessage(msg);
    });
  }

  // --- Zero-Copy Memory Access ---

  public getCurrentStepIndex(): number {
    return this.memory.getCurrentStepIndex();
  }

  public getMetrics(): TelemetryMetricsSnapshot {
    return this.memory.getMetricsSnapshot();
  }

  public getStatus(): SolverStatusFlagValue {
    return this.memory.getStatus();
  }

  public readStep(index: number, out?: MutableWeavingStepRecord): WeavingStepRecord {
    return this.memory.readStep(index, out);
  }

  public readSteps(startIndex = 0, count?: number): WeavingStepRecord[] {
    return this.memory.readSteps(startIndex, count);
  }

  // --- Event Subscriptions ---

  public onProgress(cb: (progress: ProgressNotification) => void): () => void {
    this.onProgressCallbacks.add(cb);
    return () => this.onProgressCallbacks.delete(cb);
  }

  public onDone(cb: (done: ProgressNotification) => void): () => void {
    this.onDoneCallbacks.add(cb);
    return () => this.onDoneCallbacks.delete(cb);
  }

  public onPaused(cb: (step: number) => void): () => void {
    this.onPausedCallbacks.add(cb);
    return () => this.onPausedCallbacks.delete(cb);
  }

  public onError(cb: (err: string) => void): () => void {
    this.onErrorCallbacks.add(cb);
    return () => this.onErrorCallbacks.delete(cb);
  }

  public dispose(): void {
    this.abortSolver();
    this.worker?.terminate();
    this.worker = null;
    this.isInitialized = false;
    this.wasmReady = false;
    this.onProgressCallbacks.clear();
    this.onDoneCallbacks.clear();
    this.onPausedCallbacks.clear();
    this.onErrorCallbacks.clear();
    this.pendingCamExports.clear();
  }
}
