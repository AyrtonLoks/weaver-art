/**
 * Shared memory layout conforming to ADR-003.
 *
 * Encapsulates a SharedArrayBuffer (with transparent ArrayBuffer fallback) partitioned into:
 * 1. ControlBlock (first 128 bytes): Atomic state words and Float32 metrics.
 * 2. WeavingPathBuffer (byte 128 onwards): 8-byte packed chord records with zero-copy readers.
 */

import type { PinWindingDirection, SolverStatusFlagValue, WeavingStepRecord } from '../domain-contracts/types.js';
import { SolverStatusFlag } from '../domain-contracts/types.js';

export const CONTROL_BLOCK_BYTES = 128;
export const BYTES_PER_STEP = 8;
export const DEFAULT_MAX_STEPS = 20_000;
export const MAX_SPOOLS = 16;

/** Control Block Int32 word offsets (bytes 0..31, words 0..7). */
export const CTRL_INT32_STATUS_FLAG = 0; // byte 0
export const CTRL_INT32_CURRENT_STEP = 1; // byte 4
export const CTRL_INT32_ACTIVE_SPOOL = 2; // byte 8
export const CTRL_INT32_TOTAL_SWITCHES = 3; // byte 12
export const CTRL_INT32_WORDS = 8; // 32 bytes

/** Control Block Float32 word offsets relative to byte 32 (bytes 32..127, words 0..23). */
export const CTRL_FLOAT32_RMSE = 0; // byte 32
export const CTRL_FLOAT32_DELTA_E = 1; // byte 36
export const CTRL_FLOAT32_SSIM = 2; // byte 40
export const CTRL_FLOAT32_TOTAL_METERS = 3; // byte 44
export const CTRL_FLOAT32_SPOOL_METERS_BASE = 4; // bytes 48..111 (16 float32s: 4..19)
export const CTRL_FLOAT32_WORDS = 24; // 96 bytes

/** Mutable weaving step record to enable zero-allocation reuse during iterative reads. */
export interface MutableWeavingStepRecord {
  fromPin: number;
  toPin: number;
  spoolId: number;
  departureWinding: PinWindingDirection;
  arrivalWinding: PinWindingDirection;
  scoreNormalized: number;
}

/** Telemetry metrics snapshot retrieved atomically from the control block. */
export interface TelemetryMetricsSnapshot {
  rmse: number;
  deltaE: number;
  ssim: number;
  totalThreadMeters: number;
  threadMetersPerSpool: number[];
}

/** Configuration options for SharedWorkspaceMemory allocation. */
export interface SharedWorkspaceMemoryOptions {
  capacitySteps?: number;
  forceFallback?: boolean;
}

/**
 * Shared memory manager providing zero-copy atomic access across Web Workers and Main Thread.
 */
export class SharedWorkspaceMemory {
  public readonly buffer: SharedArrayBuffer | ArrayBuffer;
  public readonly isShared: boolean;
  public readonly capacitySteps: number;

  private readonly controlInt32: Int32Array;
  private readonly controlFloat32: Float32Array;
  private readonly pathUint16: Uint16Array;
  private readonly pathUint8: Uint8Array;

  constructor(bufferOrCapacity?: SharedArrayBuffer | ArrayBuffer | number, options?: SharedWorkspaceMemoryOptions) {
    if (typeof bufferOrCapacity === 'number' || bufferOrCapacity === undefined) {
      const capacity =
        typeof bufferOrCapacity === 'number' ? bufferOrCapacity : (options?.capacitySteps ?? DEFAULT_MAX_STEPS);
      if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new RangeError('capacitySteps must be a positive integer');
      }
      this.capacitySteps = capacity;
      const totalBytes = CONTROL_BLOCK_BYTES + capacity * BYTES_PER_STEP;

      const supportsSAB =
        typeof SharedArrayBuffer !== 'undefined' &&
        (typeof globalThis.crossOriginIsolated !== 'boolean' || globalThis.crossOriginIsolated);

      if (supportsSAB && !options?.forceFallback) {
        this.buffer = new SharedArrayBuffer(totalBytes);
        this.isShared = true;
      } else {
        this.buffer = new ArrayBuffer(totalBytes);
        this.isShared = false;
      }
    } else {
      this.buffer = bufferOrCapacity;
      this.isShared = typeof SharedArrayBuffer !== 'undefined' && bufferOrCapacity instanceof SharedArrayBuffer;
      const availablePathBytes = this.buffer.byteLength - CONTROL_BLOCK_BYTES;
      if (availablePathBytes < 0) {
        throw new RangeError(
          `Buffer byteLength (${this.buffer.byteLength}) is smaller than control block (${CONTROL_BLOCK_BYTES})`,
        );
      }
      this.capacitySteps = Math.floor(availablePathBytes / BYTES_PER_STEP);
    }

    this.controlInt32 = new Int32Array(this.buffer, 0, CTRL_INT32_WORDS);
    this.controlFloat32 = new Float32Array(this.buffer, 32, CTRL_FLOAT32_WORDS);
    this.pathUint16 = new Uint16Array(this.buffer, CONTROL_BLOCK_BYTES, this.capacitySteps * 4);
    this.pathUint8 = new Uint8Array(this.buffer, CONTROL_BLOCK_BYTES, this.capacitySteps * BYTES_PER_STEP);
  }

  /** Checks whether SharedArrayBuffer and Cross-Origin Isolation are supported in this environment. */
  public static isSupported(): boolean {
    return (
      typeof SharedArrayBuffer !== 'undefined' &&
      (typeof globalThis.crossOriginIsolated !== 'boolean' || globalThis.crossOriginIsolated)
    );
  }

  /** Allocates a new workspace memory instance with specified chord step capacity. */
  public static create(
    capacitySteps: number = DEFAULT_MAX_STEPS,
    options?: Omit<SharedWorkspaceMemoryOptions, 'capacitySteps'>,
  ): SharedWorkspaceMemory {
    return new SharedWorkspaceMemory(capacitySteps, options);
  }

  // --- Control Block: Atomics / Fallback ---

  public getStatus(): SolverStatusFlagValue {
    return this.isShared
      ? (Atomics.load(this.controlInt32, CTRL_INT32_STATUS_FLAG) as SolverStatusFlagValue)
      : (this.controlInt32[CTRL_INT32_STATUS_FLAG] as SolverStatusFlagValue);
  }

  public setStatus(status: SolverStatusFlagValue): void {
    if (this.isShared) {
      Atomics.store(this.controlInt32, CTRL_INT32_STATUS_FLAG, status);
    } else {
      this.controlInt32[CTRL_INT32_STATUS_FLAG] = status;
    }
  }

  public getCurrentStepIndex(): number {
    return this.isShared
      ? Atomics.load(this.controlInt32, CTRL_INT32_CURRENT_STEP)
      : this.controlInt32[CTRL_INT32_CURRENT_STEP];
  }

  public setCurrentStepIndex(stepIndex: number): void {
    if (this.isShared) {
      Atomics.store(this.controlInt32, CTRL_INT32_CURRENT_STEP, stepIndex);
    } else {
      this.controlInt32[CTRL_INT32_CURRENT_STEP] = stepIndex;
    }
  }

  public getActiveSpoolIndex(): number {
    return this.isShared
      ? Atomics.load(this.controlInt32, CTRL_INT32_ACTIVE_SPOOL)
      : this.controlInt32[CTRL_INT32_ACTIVE_SPOOL];
  }

  public setActiveSpoolIndex(spoolIndex: number): void {
    if (this.isShared) {
      Atomics.store(this.controlInt32, CTRL_INT32_ACTIVE_SPOOL, spoolIndex);
    } else {
      this.controlInt32[CTRL_INT32_ACTIVE_SPOOL] = spoolIndex;
    }
  }

  public getTotalSpoolSwitches(): number {
    return this.isShared
      ? Atomics.load(this.controlInt32, CTRL_INT32_TOTAL_SWITCHES)
      : this.controlInt32[CTRL_INT32_TOTAL_SWITCHES];
  }

  public setTotalSpoolSwitches(switches: number): void {
    if (this.isShared) {
      Atomics.store(this.controlInt32, CTRL_INT32_TOTAL_SWITCHES, switches);
    } else {
      this.controlInt32[CTRL_INT32_TOTAL_SWITCHES] = switches;
    }
  }

  // --- Metrics ---

  public getCurrentRMSE(): number {
    return this.controlFloat32[CTRL_FLOAT32_RMSE];
  }

  public setCurrentRMSE(rmse: number): void {
    this.controlFloat32[CTRL_FLOAT32_RMSE] = rmse;
  }

  public getCurrentDeltaE(): number {
    return this.controlFloat32[CTRL_FLOAT32_DELTA_E];
  }

  public setCurrentDeltaE(deltaE: number): void {
    this.controlFloat32[CTRL_FLOAT32_DELTA_E] = deltaE;
  }

  public getCurrentSSIM(): number {
    return this.controlFloat32[CTRL_FLOAT32_SSIM];
  }

  public setCurrentSSIM(ssim: number): void {
    this.controlFloat32[CTRL_FLOAT32_SSIM] = ssim;
  }

  public getTotalThreadMeters(): number {
    return this.controlFloat32[CTRL_FLOAT32_TOTAL_METERS];
  }

  public setTotalThreadMeters(meters: number): void {
    this.controlFloat32[CTRL_FLOAT32_TOTAL_METERS] = meters;
  }

  public getSpoolThreadMeters(spoolId: number): number {
    if (spoolId < 0 || spoolId >= MAX_SPOOLS) {
      throw new RangeError(`spoolId must be between 0 and ${MAX_SPOOLS - 1}`);
    }
    return this.controlFloat32[CTRL_FLOAT32_SPOOL_METERS_BASE + spoolId];
  }

  public setSpoolThreadMeters(spoolId: number, meters: number): void {
    if (spoolId < 0 || spoolId >= MAX_SPOOLS) {
      throw new RangeError(`spoolId must be between 0 and ${MAX_SPOOLS - 1}`);
    }
    this.controlFloat32[CTRL_FLOAT32_SPOOL_METERS_BASE + spoolId] = meters;
  }

  public getMetricsSnapshot(): TelemetryMetricsSnapshot {
    const threadMetersPerSpool: number[] = new Array(MAX_SPOOLS);
    for (let i = 0; i < MAX_SPOOLS; i++) {
      threadMetersPerSpool[i] = this.controlFloat32[CTRL_FLOAT32_SPOOL_METERS_BASE + i];
    }
    return {
      rmse: this.getCurrentRMSE(),
      deltaE: this.getCurrentDeltaE(),
      ssim: this.getCurrentSSIM(),
      totalThreadMeters: this.getTotalThreadMeters(),
      threadMetersPerSpool,
    };
  }

  // --- Weaving Path Buffer: Zero-Copy and Decoded Reads ---

  public getStepFromPin(stepIndex: number): number {
    this.validateStepIndex(stepIndex);
    return this.pathUint16[stepIndex * 4];
  }

  public getStepToPin(stepIndex: number): number {
    this.validateStepIndex(stepIndex);
    return this.pathUint16[stepIndex * 4 + 1];
  }

  public getStepSpoolId(stepIndex: number): number {
    this.validateStepIndex(stepIndex);
    return this.pathUint8[stepIndex * BYTES_PER_STEP + 4];
  }

  public getStepDepartureWinding(stepIndex: number): PinWindingDirection {
    this.validateStepIndex(stepIndex);
    const flags = this.pathUint8[stepIndex * BYTES_PER_STEP + 5];
    return (flags & 1) === 1 ? 'CCW' : 'CW';
  }

  public getStepArrivalWinding(stepIndex: number): PinWindingDirection {
    this.validateStepIndex(stepIndex);
    const flags = this.pathUint8[stepIndex * BYTES_PER_STEP + 5];
    return (flags & 2) === 2 ? 'CCW' : 'CW';
  }

  public getStepScoreNormalized(stepIndex: number): number {
    this.validateStepIndex(stepIndex);
    return this.pathUint16[stepIndex * 4 + 3] / 65535;
  }

  public readStep(stepIndex: number, out?: MutableWeavingStepRecord): WeavingStepRecord {
    this.validateStepIndex(stepIndex);
    const u16Base = stepIndex * 4;
    const u8Base = stepIndex * BYTES_PER_STEP;

    const fromPin = this.pathUint16[u16Base];
    const toPin = this.pathUint16[u16Base + 1];
    const spoolId = this.pathUint8[u8Base + 4];
    const flags = this.pathUint8[u8Base + 5];
    const departureWinding: PinWindingDirection = (flags & 1) === 1 ? 'CCW' : 'CW';
    const arrivalWinding: PinWindingDirection = (flags & 2) === 2 ? 'CCW' : 'CW';
    const scoreNormalized = this.pathUint16[u16Base + 3] / 65535;

    if (out) {
      out.fromPin = fromPin;
      out.toPin = toPin;
      out.spoolId = spoolId;
      out.departureWinding = departureWinding;
      out.arrivalWinding = arrivalWinding;
      out.scoreNormalized = scoreNormalized;
      return out;
    }

    return {
      fromPin,
      toPin,
      spoolId,
      departureWinding,
      arrivalWinding,
      scoreNormalized,
    };
  }

  public writeStep(stepIndex: number, step: WeavingStepRecord): void {
    this.validateStepIndex(stepIndex);
    const u16Base = stepIndex * 4;
    const u8Base = stepIndex * BYTES_PER_STEP;

    this.pathUint16[u16Base] = step.fromPin;
    this.pathUint16[u16Base + 1] = step.toPin;
    this.pathUint8[u8Base + 4] = step.spoolId & 0xff;

    const flags = (step.departureWinding === 'CCW' ? 1 : 0) | (step.arrivalWinding === 'CCW' ? 2 : 0);
    this.pathUint8[u8Base + 5] = flags;

    const clamped = Math.max(0, Math.min(1, step.scoreNormalized));
    this.pathUint16[u16Base + 3] = Math.round(clamped * 65535);
  }

  public readSteps(startIndex = 0, count?: number): WeavingStepRecord[] {
    const totalAvailable = this.getCurrentStepIndex();
    const effectiveCount =
      count !== undefined ? Math.min(count, totalAvailable - startIndex) : totalAvailable - startIndex;
    if (effectiveCount <= 0) return [];

    const result: WeavingStepRecord[] = new Array(effectiveCount);
    for (let i = 0; i < effectiveCount; i++) {
      result[i] = this.readStep(startIndex + i);
    }
    return result;
  }

  public reset(): void {
    this.controlInt32.fill(0);
    this.controlFloat32.fill(0);
    this.setStatus(SolverStatusFlag.IDLE);
  }

  private validateStepIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.capacitySteps) {
      throw new RangeError(`stepIndex ${index} out of range [0, ${this.capacitySteps - 1}]`);
    }
  }
}
