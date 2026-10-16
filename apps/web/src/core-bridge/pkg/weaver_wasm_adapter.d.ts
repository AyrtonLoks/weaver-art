/* tslint:disable */
/* eslint-disable */

export class WasmWeavingEngine {
    free(): void;
    [Symbol.dispose](): void;
    apply_user_importance_brush(brush_weights: Float32Array): void;
    generate_artwork_svg(): string;
    generate_cnc_gcode(): string;
    generate_drilling_blueprint_pdf(): Uint8Array;
    generate_drilling_blueprint_svg(): string;
    generate_drilling_csv(): string;
    get_bom_summary_json(): string;
    get_diagnostics_dimensions(): Uint32Array;
    get_edges_rgba(): Uint8Array;
    get_importance_map_rgba(): Uint8Array;
    get_prepared_target_rgba(): Uint8Array;
    get_radon_sinogram_rgba(): Uint8Array;
    init_solver(config_json: string): void;
    load_and_prepare_image(raw_rgba: Uint8Array, width: number, height: number, config_json: string): string;
    constructor(shared_buffer: any);
    step_solver_batch(batch_size: number): boolean;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmweavingengine_free: (a: number, b: number) => void;
    readonly wasmweavingengine_apply_user_importance_brush: (a: number, b: number, c: number) => void;
    readonly wasmweavingengine_generate_artwork_svg: (a: number) => [number, number, number, number];
    readonly wasmweavingengine_generate_cnc_gcode: (a: number) => [number, number, number, number];
    readonly wasmweavingengine_generate_drilling_blueprint_pdf: (a: number) => [number, number, number, number];
    readonly wasmweavingengine_generate_drilling_blueprint_svg: (a: number) => [number, number, number, number];
    readonly wasmweavingengine_generate_drilling_csv: (a: number) => [number, number, number, number];
    readonly wasmweavingengine_get_bom_summary_json: (a: number) => [number, number, number, number];
    readonly wasmweavingengine_get_diagnostics_dimensions: (a: number) => [number, number];
    readonly wasmweavingengine_get_edges_rgba: (a: number) => [number, number];
    readonly wasmweavingengine_get_importance_map_rgba: (a: number) => [number, number];
    readonly wasmweavingengine_get_prepared_target_rgba: (a: number) => [number, number];
    readonly wasmweavingengine_get_radon_sinogram_rgba: (a: number) => [number, number];
    readonly wasmweavingengine_init_solver: (a: number, b: number, c: number) => [number, number];
    readonly wasmweavingengine_load_and_prepare_image: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly wasmweavingengine_new: (a: any) => [number, number, number];
    readonly wasmweavingengine_step_solver_batch: (a: number, b: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
