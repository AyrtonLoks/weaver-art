import type { EvaluatorFactory, EvaluatorSetup } from '@weaver-art/core';
import { instantiateWasmKernel, WasmEvaluator } from './wasm-evaluator.js';

export { WasmEvaluator, instantiateWasmKernel };

/**
 * Checks whether WebAssembly SIMD 128 is supported by the current runtime.
 */
export function wasmSimdSupported(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 26, 11,
      ]),
    );
  } catch {
    return false;
  }
}

/**
 * Creates an EvaluatorFactory that instantiates the Rust SIMD WebAssembly kernel.
 */
export async function createWasmEvaluator(): Promise<EvaluatorFactory> {
  return async (setup: EvaluatorSetup) => {
    return instantiateWasmKernel(setup);
  };
}
