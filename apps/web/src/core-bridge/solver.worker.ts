/**
 * Dedicated Web Worker for the Weaver Art Wasm Solver (Sprint 3 / Task 3.3).
 *
 * Runs the WebAssembly simulation kernel in a non-blocking background thread,
 * managing iterative batches of step_solver_batch(50), updating the SharedArrayBuffer
 * atomic ControlBlock, and communicating with the UI thread via message passing.
 */

import initWasm, { WasmWeavingEngine } from './pkg/weaver_wasm_adapter.js';
import { SharedWorkspaceMemory } from './shared-memory-layout.js';
import { SolverStatusFlag } from '../domain-contracts/types.js';

export type CamExportType =
  'blueprint_svg' | 'blueprint_pdf' | 'drilling_csv' | 'cnc_gcode' | 'artwork_svg' | 'bom_json';

/** Messages received by the solver worker from the Main Thread. */
export type ToSolverWorkerMessage =
  | {
      type: 'INIT';
      buffer: SharedArrayBuffer | ArrayBuffer;
      capacitySteps?: number;
    }
  | {
      type: 'LOAD_AND_PREPARE_IMAGE';
      rawRgba: ArrayBuffer;
      width: number;
      height: number;
      configJson: string;
    }
  | {
      type: 'APPLY_BRUSH';
      brushWeights: Float32Array;
    }
  | {
      type: 'INIT_SOLVER';
      configJson: string;
    }
  | {
      type: 'START';
      batchSize?: number;
    }
  | {
      type: 'PAUSE';
    }
  | {
      type: 'ABORT';
    }
  | {
      type: 'EXPORT_CAM';
      camType: CamExportType;
      exportId: string;
      configJson?: string;
    }
  | {
      type: 'SMART_FRAME';
      rawRgba: ArrayBuffer;
      width: number;
      height: number;
      targetRatio: number;
    };

/** Messages dispatched by the solver worker to the Main Thread. */
export type FromSolverWorkerMessage =
  | {
      type: 'READY';
      isShared: boolean;
      capacitySteps: number;
    }
  | {
      type: 'IMAGE_PREPARED';
      summaryJson: string;
      preparedRgba: ArrayBuffer;
      importanceRgba: ArrayBuffer;
      edgesRgba: ArrayBuffer;
      radonRgba: ArrayBuffer;
      dimensions: number[];
    }
  | {
      type: 'BRUSH_APPLIED';
      importanceRgba: ArrayBuffer;
    }
  | {
      type: 'SOLVER_INITIALIZED';
    }
  | {
      type: 'PROGRESS';
      currentStep: number;
      rmse: number;
      deltaE: number;
      ssim: number;
      totalThreadMeters: number;
    }
  | {
      type: 'PAUSED';
      currentStep: number;
    }
  | {
      type: 'DONE';
      currentStep: number;
      rmse: number;
      deltaE: number;
      ssim: number;
      totalThreadMeters: number;
    }
  | {
      type: 'ABORTED';
      currentStep: number;
    }
  | {
      type: 'CAM_EXPORT_RESULT';
      exportId: string;
      result: string | Uint8Array;
    }
  | {
      type: 'SMART_FRAME_RESULT';
      resultJson: string;
    }
  | {
      type: 'ERROR';
      message: string;
      fatal?: boolean;
    };

// Worker execution state
let wasmEngine: WasmWeavingEngine | null = null;
let memory: SharedWorkspaceMemory | null = null;
let isRunning = false;
let isPaused = false;
let isAborted = false;

function post(msg: FromSolverWorkerMessage, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

async function handleInit(msg: Extract<ToSolverWorkerMessage, { type: 'INIT' }>): Promise<void> {
  try {
    await initWasm();
    memory = new SharedWorkspaceMemory(msg.buffer);
    wasmEngine = new WasmWeavingEngine(msg.buffer);

    post({
      type: 'READY',
      isShared: memory.isShared,
      capacitySteps: memory.capacitySteps,
    });
  } catch (err) {
    post({
      type: 'ERROR',
      message: `Falha na inicialização do Wasm / SharedArrayBuffer: ${err instanceof Error ? err.message : String(err)}`,
      fatal: true,
    });
  }
}

async function handlePrepareImage(
  msg: Extract<ToSolverWorkerMessage, { type: 'LOAD_AND_PREPARE_IMAGE' }>,
): Promise<void> {
  if (!wasmEngine) {
    post({ type: 'ERROR', message: 'Wasm engine not initialized' });
    return;
  }

  try {
    const rawBytes = new Uint8Array(msg.rawRgba);
    const summaryJson = wasmEngine.load_and_prepare_image(rawBytes, msg.width, msg.height, msg.configJson);

    const prep = wasmEngine.get_prepared_target_rgba();
    const imp = wasmEngine.get_importance_map_rgba();
    const edge = wasmEngine.get_edges_rgba();
    const radon = wasmEngine.get_radon_sinogram_rgba();
    const dims = Array.from(wasmEngine.get_diagnostics_dimensions());

    function copyToConventionalArrayBuffer(view: Uint8Array): ArrayBuffer {
      const copy = new ArrayBuffer(view.byteLength);
      new Uint8Array(copy).set(view);
      return copy;
    }

    const prepBuf = copyToConventionalArrayBuffer(prep);
    const impBuf = copyToConventionalArrayBuffer(imp);
    const edgeBuf = copyToConventionalArrayBuffer(edge);
    const radonBuf = copyToConventionalArrayBuffer(radon);

    post(
      {
        type: 'IMAGE_PREPARED',
        summaryJson,
        preparedRgba: prepBuf,
        importanceRgba: impBuf,
        edgesRgba: edgeBuf,
        radonRgba: radonBuf,
        dimensions: dims,
      },
      [prepBuf, impBuf, edgeBuf, radonBuf],
    );
  } catch (err) {
    post({
      type: 'ERROR',
      message: `Erro no processamento DSP: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function handleApplyBrush(msg: Extract<ToSolverWorkerMessage, { type: 'APPLY_BRUSH' }>): void {
  if (!wasmEngine) return;
  try {
    wasmEngine.apply_user_importance_brush(msg.brushWeights);
    const imp = wasmEngine.get_importance_map_rgba();
    const impBuf = new ArrayBuffer(imp.byteLength);
    new Uint8Array(impBuf).set(imp);
    post({ type: 'BRUSH_APPLIED', importanceRgba: impBuf }, [impBuf]);
  } catch (err) {
    post({
      type: 'ERROR',
      message: `Erro ao aplicar pincel de foco: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function handleInitSolver(msg: Extract<ToSolverWorkerMessage, { type: 'INIT_SOLVER' }>): void {
  if (!wasmEngine) {
    post({ type: 'ERROR', message: 'Wasm engine not initialized' });
    return;
  }
  try {
    wasmEngine.init_solver(msg.configJson);
    post({ type: 'SOLVER_INITIALIZED' });
  } catch (err) {
    post({
      type: 'ERROR',
      message: `Erro ao inicializar solver: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function runSolverBatchLoop(batchSize = 50): Promise<void> {
  if (!wasmEngine || !memory) return;

  isRunning = true;
  isPaused = false;
  isAborted = false;
  memory.setStatus(SolverStatusFlag.RUNNING);

  while (isRunning && !isPaused && !isAborted) {
    // 1. Executa lote de passos no núcleo Wasm/Rust
    const stillRunning = wasmEngine.step_solver_batch(batchSize);

    const currentStep = memory.getCurrentStepIndex();
    const rmse = memory.getCurrentRMSE();
    const deltaE = memory.getCurrentDeltaE();
    const ssim = memory.getCurrentSSIM();
    const totalThreadMeters = memory.getTotalThreadMeters();

    // 2. Notifica progresso em tempo real para a Main Thread
    post({
      type: 'PROGRESS',
      currentStep,
      rmse,
      deltaE,
      ssim,
      totalThreadMeters,
    });

    if (!stillRunning) {
      isRunning = false;
      const status = memory.getStatus();
      if (status === SolverStatusFlag.PAUSED) {
        post({ type: 'PAUSED', currentStep });
      } else if (status === SolverStatusFlag.ABORT) {
        post({ type: 'ABORTED', currentStep });
      } else {
        post({
          type: 'DONE',
          currentStep,
          rmse,
          deltaE,
          ssim,
          totalThreadMeters,
        });
      }
      break;
    }

    // 3. Cede a vez na fila de tarefas (event loop) para permitir receber
    // mensagens de PAUSE, ABORT ou APPLY_BRUSH entre os lotes
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function handleStart(msg: Extract<ToSolverWorkerMessage, { type: 'START' }>): void {
  if (isRunning) return;
  const batch = msg.batchSize ?? 50;
  void runSolverBatchLoop(batch);
}

function handlePause(): void {
  isPaused = true;
  isRunning = false;
  if (memory) {
    memory.setStatus(SolverStatusFlag.PAUSED);
  }
  const currentStep = memory?.getCurrentStepIndex() ?? 0;
  post({ type: 'PAUSED', currentStep });
}

function handleAbort(): void {
  isAborted = true;
  isRunning = false;
  if (memory) {
    memory.setStatus(SolverStatusFlag.ABORT);
  }
  const currentStep = memory?.getCurrentStepIndex() ?? 0;
  post({ type: 'ABORTED', currentStep });
}

function handleExportCam(msg: Extract<ToSolverWorkerMessage, { type: 'EXPORT_CAM' }>): void {
  if (!wasmEngine) {
    post({ type: 'ERROR', message: 'Wasm engine not initialized' });
    return;
  }

  try {
    if (msg.configJson) {
      try {
        wasmEngine.init_solver(msg.configJson);
      } catch (e) {
        console.warn('init_solver warning before CAM export:', e);
      }
    }

    let result: string | Uint8Array;
    switch (msg.camType) {
      case 'blueprint_svg':
        result = wasmEngine.generate_drilling_blueprint_svg();
        break;
      case 'blueprint_pdf':
        result = wasmEngine.generate_drilling_blueprint_pdf();
        break;
      case 'drilling_csv':
        result = wasmEngine.generate_drilling_csv();
        break;
      case 'cnc_gcode':
        result = wasmEngine.generate_cnc_gcode();
        break;
      case 'artwork_svg':
        result = wasmEngine.generate_artwork_svg();
        break;
      case 'bom_json':
        result = wasmEngine.get_bom_summary_json();
        break;
    }

    post({
      type: 'CAM_EXPORT_RESULT',
      exportId: msg.exportId,
      result,
    });
  } catch (err) {
    post({
      type: 'ERROR',
      message: `Erro na exportação CAM (${msg.camType}): ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function handleSmartFrame(msg: Extract<ToSolverWorkerMessage, { type: 'SMART_FRAME' }>): void {
  if (!wasmEngine) {
    post({ type: 'ERROR', message: 'Wasm engine not initialized' });
    return;
  }
  try {
    const rawBytes = new Uint8Array(msg.rawRgba);
    const resultJson = wasmEngine.compute_smart_framing_wasm(rawBytes, msg.width, msg.height, msg.targetRatio);
    post({ type: 'SMART_FRAME_RESULT', resultJson });
  } catch (err) {
    post({
      type: 'ERROR',
      message: `Erro no auto-enquadramento facial: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// Escuta de mensagens do Worker
self.onmessage = (e: MessageEvent<ToSolverWorkerMessage>): void => {
  const msg = e.data;
  switch (msg.type) {
    case 'INIT':
      void handleInit(msg);
      break;
    case 'LOAD_AND_PREPARE_IMAGE':
      void handlePrepareImage(msg);
      break;
    case 'APPLY_BRUSH':
      handleApplyBrush(msg);
      break;
    case 'INIT_SOLVER':
      handleInitSolver(msg);
      break;
    case 'START':
      handleStart(msg);
      break;
    case 'PAUSE':
      handlePause();
      break;
    case 'ABORT':
      handleAbort();
      break;
    case 'EXPORT_CAM':
      handleExportCam(msg);
      break;
    case 'SMART_FRAME':
      handleSmartFrame(msg);
      break;
  }
};
