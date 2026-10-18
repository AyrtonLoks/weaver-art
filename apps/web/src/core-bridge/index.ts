/**
 * Core bridge: Web Worker client contracts, atomic SharedArrayBuffer ring-buffer reader,
 * shared memory layout (ADR-003), and solver lifecycle state management.
 */

export * from './shared-memory-layout.js';
export * from './engine-client.js';
export type {
  ToSolverWorkerMessage,
  FromSolverWorkerMessage,
  CamExportType,
  WorkerOp,
  ToSolverWorkerMessage as ToWorker,
  FromSolverWorkerMessage as FromWorker,
} from './solver.worker.js';

/** Lifecycle state of the asynchronous Wasm solver worker. */
export type SolverLifecycleState = 'idle' | 'initializing' | 'running' | 'paused' | 'completed' | 'aborted' | 'error';

/** Number of Int32 control header words at the start of the SharedArrayBuffer ring-buffer. */
export const RING_BUFFER_HEADER_WORDS = 4;

/** Control header indices in the Int32Array view: [writeIndex, readIndex, statusFlags, totalSteps]. */
export const RING_CONTROL_WRITE_INDEX = 0;
export const RING_CONTROL_READ_INDEX = 1;
export const RING_CONTROL_STATUS_FLAGS = 2;
export const RING_CONTROL_TOTAL_STEPS = 3;

/** Atomic ring-buffer layout view backed by a SharedArrayBuffer. */
export interface SharedRingBufferView {
  readonly buffer: SharedArrayBuffer;
  /** Int32 control header: [writeIndex, readIndex, statusFlags, totalSteps]. */
  readonly control: Int32Array;
  /** Packed chord telemetry payload. */
  readonly payload: Float32Array;
  /** Maximum number of float elements in the payload section. */
  readonly capacityFloats: number;
}

/** Checks whether the browser context has COOP/COEP Cross-Origin Isolation enabled for SharedArrayBuffer. */
export function isCrossOriginIsolatedContext(): boolean {
  return typeof globalThis.crossOriginIsolated === 'boolean' && globalThis.crossOriginIsolated;
}

/** Allocates a SharedArrayBuffer ring-buffer view with an atomic Int32 control header and Float32 payload. */
export function createSharedRingBuffer(capacityFloats: number): SharedRingBufferView {
  if (!Number.isInteger(capacityFloats) || capacityFloats <= 0) {
    throw new RangeError('capacityFloats must be a positive integer');
  }
  const headerBytes = RING_BUFFER_HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;
  const payloadBytes = capacityFloats * Float32Array.BYTES_PER_ELEMENT;
  const buffer = new SharedArrayBuffer(headerBytes + payloadBytes);
  const control = new Int32Array(buffer, 0, RING_BUFFER_HEADER_WORDS);
  const payload = new Float32Array(buffer, headerBytes, capacityFloats);
  return { buffer, control, payload, capacityFloats };
}

/** Atomically reads the current write index from the ring-buffer control header. */
export function readRingBufferWriteIndexAtomically(view: SharedRingBufferView): number {
  return Atomics.load(view.control, RING_CONTROL_WRITE_INDEX);
}

/** Atomically reads the current read index from the ring-buffer control header. */
export function readRingBufferReadIndexAtomically(view: SharedRingBufferView): number {
  return Atomics.load(view.control, RING_CONTROL_READ_INDEX);
}

/** Atomically advances the read index after consuming slots from the ring-buffer. */
export function commitRingBufferReadIndexAtomically(view: SharedRingBufferView, nextReadIndex: number): void {
  Atomics.store(view.control, RING_CONTROL_READ_INDEX, nextReadIndex);
}
