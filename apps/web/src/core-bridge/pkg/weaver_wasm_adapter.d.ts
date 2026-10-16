/* tslint:disable */
/* eslint-disable */
/**
 * TypeScript definitions for weaver_wasm_adapter WebAssembly bindings.
 */

export class WasmWeavingEngine {
  free(): void;
  /**
   * Initializes the Wasm engine connected to a SharedArrayBuffer or ArrayBuffer.
   */
  constructor(shared_buffer: ArrayBufferLike);
  /**
   * Runs the complete DSP pipeline on the raw RGBA image.
   */
  load_and_prepare_image(raw_rgba: Uint8Array, width: number, height: number, config_json: string): string;
  /**
   * Applies manual focus brush without recomputing upstream DSP stages.
   */
  apply_user_importance_brush(brush_weights: Float32Array): void;
  /**
   * Initializes the solver session and CSR chord matrix.
   */
  init_solver(config_json: string): void;
  /**
   * Steps a batch of chords, directly writing binary records and atomic telemetry.
   */
  step_solver_batch(batch_size: number): boolean;
  /**
   * Returns the prepared target RGBA preview bytes.
   */
  get_prepared_target_rgba(): Uint8Array;
  /**
   * Returns the importance heatmap RGBA bytes.
   */
  get_importance_map_rgba(): Uint8Array;
  /**
   * Returns the Canny/Sobel structural edges RGBA bytes.
   */
  get_edges_rgba(): Uint8Array;
  /**
   * Returns the filtered Radon sinogram RGBA bytes.
   */
  get_radon_sinogram_rgba(): Uint8Array;
  /**
   * Returns the diagnostic dimensions [prepW, prepH, impW, impH, edgeW, edgeH, radonW, radonH].
   */
  get_diagnostics_dimensions(): Uint32Array;
  /**
   * Generates master drilling blueprint SVG.
   */
  generate_drilling_blueprint_svg(): string;
  /**
   * Generates multipage 1:1 drilling blueprint PDF.
   */
  generate_drilling_blueprint_pdf(): Uint8Array;
  /**
   * Generates technical mechanical drilling CSV.
   */
  generate_drilling_csv(): string;
  /**
   * Generates CNC G-Code (G81/G83 canned cycles).
   */
  generate_cnc_gcode(): string;
  /**
   * Generates artwork vector SVG in physical stacking order.
   */
  generate_artwork_svg(): string;
  /**
   * Generates Bill of Materials and project metadata JSON.
   */
  get_bom_summary_json(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmweavingengine_free: (a: number, b: number) => void;
}

export default function init(input?: InitInput | Promise<InitInput>): Promise<InitOutput>;
