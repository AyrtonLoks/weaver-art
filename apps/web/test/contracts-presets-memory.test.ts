import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_STEP,
  CONTROL_BLOCK_BYTES,
  DEFAULT_MAX_STEPS,
  MAX_SPOOLS,
  SharedWorkspaceMemory,
} from '../src/core-bridge/index.js';
import type {
  ColorErrorMetricType,
  ColorPaletteMode,
  EdgeDetectorType,
  FramingTransform,
  LoomPhysicalSpec,
  LoomShapeType,
  MorphologyOpType,
  OpticalMixModelType,
  RasterizerType,
  SolverAlgorithmType,
  SpoolSwitchStrategyType,
  WeaverConfig,
} from '../src/domain-contracts/index.js';
import { SolverStatusFlag } from '../src/domain-contracts/index.js';
import {
  getVisibleControls,
  isControlVisible,
  ReactivePresetStore,
  WEAVER_PRESET_PROFILES,
} from '../src/preset-engine/index.js';

describe('Task 0.3 — Contratos de Domínio, Memória Compartilhada e Presets', () => {
  describe('1. Contratos de Domínio (domain-contracts)', () => {
    it('valida especificações físicas e tipos estritos sem any', () => {
      const shape: LoomShapeType = 'CIRCULAR';
      const spec: LoomPhysicalSpec = {
        shape,
        pinCount: 200,
        diameterMm: 600,
        widthMm: 600,
        heightMm: 600,
        pinDiameterMm: 2.0,
        threadThicknessMm: 0.15,
        drillBitMm: 2.0,
        edgeMarginMm: 15.0,
      };

      expect(spec.shape).toBe('CIRCULAR');
      expect(spec.pinCount).toBe(200);
      expect(spec.diameterMm).toBe(600);

      const paletteMode: ColorPaletteMode = 'VRELLIS_5_COLOR';
      const opticalModel: OpticalMixModelType = 'PORTER_DUFF_OCCLUSION';
      const errorMetric: ColorErrorMetricType = 'CIELAB_DELTA_E2000';
      const solver: SolverAlgorithmType = 'ITERATIVE_GREEDY';
      const spoolStrategy: SpoolSwitchStrategyType = 'SEPARATED_CHANNELS';
      const rasterizer: RasterizerType = 'XIAOLIN_WU_ANTIALIASED';
      const morphology: MorphologyOpType = 'NONE';
      const edgeDetector: EdgeDetectorType = 'SOBEL';

      expect(paletteMode).toBe('VRELLIS_5_COLOR');
      expect(opticalModel).toBe('PORTER_DUFF_OCCLUSION');
      expect(errorMetric).toBe('CIELAB_DELTA_E2000');
      expect(solver).toBe('ITERATIVE_GREEDY');
      expect(spoolStrategy).toBe('SEPARATED_CHANNELS');
      expect(rasterizer).toBe('XIAOLIN_WU_ANTIALIASED');
      expect(morphology).toBe('NONE');
      expect(edgeDetector).toBe('SOBEL');

      const framing: FramingTransform = {
        zoom: 1.25,
        panXPercent: 0,
        panYPercent: -5,
        rotationDeg: 0,
        autoFaceTargetRatio: 0.8,
      };
      expect(framing.zoom).toBe(1.25);
      expect(framing.autoFaceTargetRatio).toBe(0.8);
    });
  });

  describe('2. Layout Binário SharedArrayBuffer (core-bridge / ADR-003)', () => {
    it('aloca layout com 128 bytes de ControlBlock e WeavingPathBuffer de 8 bytes por passo', () => {
      const memory = new SharedWorkspaceMemory(DEFAULT_MAX_STEPS, { forceFallback: true });
      expect(memory.capacitySteps).toBe(DEFAULT_MAX_STEPS);
      expect(memory.isShared).toBe(false);
      expect(memory.buffer.byteLength).toBe(CONTROL_BLOCK_BYTES + DEFAULT_MAX_STEPS * BYTES_PER_STEP);
    });

    it('opera indices de controle atômicos e fallbacks de status', () => {
      const memory = new SharedWorkspaceMemory(100, { forceFallback: true });
      expect(memory.getStatus()).toBe(SolverStatusFlag.IDLE);

      memory.setStatus(SolverStatusFlag.RUNNING);
      expect(memory.getStatus()).toBe(SolverStatusFlag.RUNNING);

      memory.setCurrentStepIndex(42);
      expect(memory.getCurrentStepIndex()).toBe(42);

      memory.setActiveSpoolIndex(3);
      expect(memory.getActiveSpoolIndex()).toBe(3);

      memory.setTotalSpoolSwitches(15);
      expect(memory.getTotalSpoolSwitches()).toBe(15);

      memory.setStatus(SolverStatusFlag.DONE);
      expect(memory.getStatus()).toBe(SolverStatusFlag.DONE);
    });

    it('grava e recupera métricas Float32 do bloco de controle', () => {
      const memory = new SharedWorkspaceMemory(50, { forceFallback: true });
      memory.setCurrentRMSE(0.045);
      memory.setCurrentDeltaE(2.35);
      memory.setCurrentSSIM(0.82);
      memory.setTotalThreadMeters(1850.5);

      expect(memory.getCurrentRMSE()).toBeCloseTo(0.045, 3);
      expect(memory.getCurrentDeltaE()).toBeCloseTo(2.35, 2);
      expect(memory.getCurrentSSIM()).toBeCloseTo(0.82, 2);
      expect(memory.getTotalThreadMeters()).toBeCloseTo(1850.5, 1);

      memory.setSpoolThreadMeters(0, 450.25);
      memory.setSpoolThreadMeters(1, 320.1);
      memory.setSpoolThreadMeters(15, 120.0);

      expect(memory.getSpoolThreadMeters(0)).toBeCloseTo(450.25, 2);
      expect(memory.getSpoolThreadMeters(1)).toBeCloseTo(320.1, 1);
      expect(memory.getSpoolThreadMeters(15)).toBeCloseTo(120.0, 1);

      const snapshot = memory.getMetricsSnapshot();
      expect(snapshot.rmse).toBeCloseTo(0.045, 3);
      expect(snapshot.deltaE).toBeCloseTo(2.35, 2);
      expect(snapshot.ssim).toBeCloseTo(0.82, 2);
      expect(snapshot.totalThreadMeters).toBeCloseTo(1850.5, 1);
      expect(snapshot.threadMetersPerSpool.length).toBe(MAX_SPOOLS);
      expect(snapshot.threadMetersPerSpool[0]).toBeCloseTo(450.25, 2);

      expect(() => memory.getSpoolThreadMeters(16)).toThrow(RangeError);
      expect(() => memory.setSpoolThreadMeters(-1, 0)).toThrow(RangeError);
    });

    it('grava passos de tecelagem e lê via métodos zero-copy tipados', () => {
      const memory = new SharedWorkspaceMemory(500, { forceFallback: true });

      const step0 = {
        fromPin: 12,
        toPin: 188,
        spoolId: 1,
        departureWinding: 'CW' as const,
        arrivalWinding: 'CCW' as const,
        scoreNormalized: 0.854,
      };

      const step1 = {
        fromPin: 188,
        toPin: 45,
        spoolId: 2,
        departureWinding: 'CCW' as const,
        arrivalWinding: 'CW' as const,
        scoreNormalized: 0.421,
      };

      memory.writeStep(0, step0);
      memory.writeStep(1, step1);
      memory.setCurrentStepIndex(2);

      // Leitura zero-copy direta
      expect(memory.getStepFromPin(0)).toBe(12);
      expect(memory.getStepToPin(0)).toBe(188);
      expect(memory.getStepSpoolId(0)).toBe(1);
      expect(memory.getStepDepartureWinding(0)).toBe('CW');
      expect(memory.getStepArrivalWinding(0)).toBe('CCW');
      expect(memory.getStepScoreNormalized(0)).toBeCloseTo(0.854, 2);

      expect(memory.getStepFromPin(1)).toBe(188);
      expect(memory.getStepToPin(1)).toBe(45);
      expect(memory.getStepSpoolId(1)).toBe(2);
      expect(memory.getStepDepartureWinding(1)).toBe('CCW');
      expect(memory.getStepArrivalWinding(1)).toBe('CW');
      expect(memory.getStepScoreNormalized(1)).toBeCloseTo(0.421, 2);

      // Leitura decodificada
      const decoded0 = memory.readStep(0);
      expect(decoded0.fromPin).toBe(12);
      expect(decoded0.toPin).toBe(188);
      expect(decoded0.spoolId).toBe(1);
      expect(decoded0.departureWinding).toBe('CW');
      expect(decoded0.arrivalWinding).toBe('CCW');
      expect(decoded0.scoreNormalized).toBeCloseTo(0.854, 2);

      // Leitura zero-allocation reutilizando buffer mutável
      const reusable = {
        fromPin: 0,
        toPin: 0,
        spoolId: 0,
        departureWinding: 'CW' as const,
        arrivalWinding: 'CW' as const,
        scoreNormalized: 0,
      };
      const returned = memory.readStep(1, reusable);
      expect(returned).toBe(reusable);
      expect(reusable.fromPin).toBe(188);
      expect(reusable.toPin).toBe(45);
      expect(reusable.spoolId).toBe(2);

      // Array de passos
      const allSteps = memory.readSteps(0, 2);
      expect(allSteps.length).toBe(2);
      expect(allSteps[0].toPin).toBe(188);
      expect(allSteps[1].toPin).toBe(45);
    });

    it('suporta buffer compartilhado SharedArrayBuffer quando disponível e valida limites', () => {
      if (typeof SharedArrayBuffer !== 'undefined') {
        const memShared = new SharedWorkspaceMemory(100, { forceFallback: false });
        expect(memShared.isShared).toBe(true);
        memShared.setStatus(SolverStatusFlag.PAUSED);
        expect(memShared.getStatus()).toBe(SolverStatusFlag.PAUSED);
      }

      expect(() => new SharedWorkspaceMemory(0)).toThrow(RangeError);
      expect(() => new SharedWorkspaceMemory(-10)).toThrow(RangeError);

      const mem = new SharedWorkspaceMemory(10, { forceFallback: true });
      expect(() => mem.getStepFromPin(10)).toThrow(RangeError);
      expect(() => mem.readStep(-1)).toThrow(RangeError);
    });
  });

  describe('3. Motor de Presets Reativos e Visibilidade Contextual (preset-engine / ADR-005)', () => {
    it('define os 2 Perfis de Preset Principais de Petros Vrellis com parâmetros exigidos', () => {
      const mono = WEAVER_PRESET_PROFILES.VRELLIS_CLASSIC_MONO.config;
      // Rodada "reconhecimento facial": 6000 linhas aproximam o brilho de fotos escuras;
      // fio de 0,18 mm superou 0,15 mm em todas as fotos; tear = aro de bicicleta 28" (ISO 622).
      expect(mono.maxLines).toBe(6000);
      expect(mono.threadThicknessMm).toBe(0.18);
      expect(mono.diameterMm).toBe(622);
      expect(mono.pinCount).toBe(200);
      // Padrões calibrados no benchmark com foto real (weaver-cli bench):
      // CLAHE e reforço de bordas pioravam a fidelidade; foco facial moderado (2.0) ajuda retratos.
      expect(mono.claheClipLimit).toBe(0);
      expect(mono.faceImportanceWeight).toBe(2.0);
      expect(mono.edgeBlendWeight).toBe(0);
      // Realce de feições e "pele mais limpa" ficam disponíveis, mas desligados por padrão.
      expect(mono.featureEmphasisWeight).toBe(0);
      expect(mono.skinLift).toBe(0);
      expect(mono.rasterizer).toBe('XIAOLIN_WU_ANTIALIASED');
      expect(mono.paletteMode).toBe('MONOCHROME');
      expect(mono.spoolStrategy).toBe('FREE_GREEDY');

      const color = WEAVER_PRESET_PROFILES.VRELLIS_COLOR.config;
      expect(color.maxLines).toBe(6000);
      expect(color.threadThicknessMm).toBe(0.18);
      expect(color.diameterMm).toBe(622);
      expect(color.pinCount).toBe(200);
      expect(color.paletteMode).toBe('CMYK_SUBTRACTIVE');
      expect(color.spoolStrategy).toBe('SEPARATED_CHANNELS');
      expect(color.opticalMixModel).toBe('PORTER_DUFF_OCCLUSION');
      expect(color.errorMetric).toBe('CIELAB_DELTA_E2000');
      expect(color.faceImportanceWeight).toBe(2.0);
      expect(color.edgeDetector).toBe('SOBEL');
      expect(color.edgeBlendWeight).toBe(0);
      expect(Object.keys(WEAVER_PRESET_PROFILES).sort()).toEqual(['VRELLIS_CLASSIC_MONO', 'VRELLIS_COLOR'].sort());
    });

    it('gerencia estado reativo isDirty por parâmetro e reset', () => {
      const store = new ReactivePresetStore('VRELLIS_CLASSIC_MONO');
      expect(store.isDirty()).toBe(false);
      expect(store.isDirty('maxLines')).toBe(false);

      let notifiedDirty = false;
      const unsub = store.subscribe((_cfg, dirty) => {
        notifiedDirty = dirty;
      });

      // Modifica parâmetro
      store.setParam('maxLines', 4200);
      expect(store.isDirty()).toBe(true);
      expect(store.isDirty('maxLines')).toBe(true);
      expect(store.isDirty('threadThicknessMm')).toBe(false);
      expect(notifiedDirty).toBe(true);

      // Reverte para o default do preset
      store.resetParam('maxLines');
      expect(store.isDirty('maxLines')).toBe(false);
      expect(store.isDirty()).toBe(false);

      // Modifica múltiplos e reseta tudo
      store.setParam('maxLines', 5000);
      store.setParam('claheClipLimit', 4.0);
      expect(store.getDirtyParams().size).toBe(2);

      store.resetAllDirty();
      expect(store.isDirty()).toBe(false);
      expect(store.getConfig().maxLines).toBe(6000);

      // Carrega outro preset
      store.loadPreset('VRELLIS_COLOR');
      expect(store.getPresetId()).toBe('VRELLIS_COLOR');
      expect(store.getConfig().maxLines).toBe(6000);
      expect(store.getConfig().paletteMode).toBe('CMYK_SUBTRACTIVE');
      expect(store.isDirty()).toBe(false);

      unsub();
    });

    it('avalia predicados de visibilidade contextual de controles', () => {
      // 1. Ocultar controles de carretel em MONOCHROME
      const monoCfg: WeaverConfig = {
        ...WEAVER_PRESET_PROFILES.VRELLIS_CLASSIC_MONO.config,
        paletteMode: 'MONOCHROME',
      };
      expect(isControlVisible('spoolStrategy', monoCfg)).toBe(false);
      expect(isControlVisible('switchPenaltyLambda', monoCfg)).toBe(false);
      expect(isControlVisible('minRunLength', monoCfg)).toBe(false);

      // 2. Exibir controles de carretel em VRELLIS_5_COLOR com estratégias específicas
      const colorCfg: WeaverConfig = {
        ...WEAVER_PRESET_PROFILES.VRELLIS_COLOR.config,
        paletteMode: 'VRELLIS_5_COLOR',
        spoolStrategy: 'SEPARATED_CHANNELS',
      };
      expect(isControlVisible('spoolStrategy', colorCfg)).toBe(true);
      expect(isControlVisible('switchPenaltyLambda', colorCfg)).toBe(false);
      expect(isControlVisible('minRunLength', colorCfg)).toBe(false);

      const hysCfg: WeaverConfig = {
        ...colorCfg,
        spoolStrategy: 'HYSTERESIS_PENALTY',
      };
      expect(isControlVisible('switchPenaltyLambda', hysCfg)).toBe(true);
      expect(isControlVisible('minRunLength', hysCfg)).toBe(true);

      // 3. Controles de borda
      const edgeNoneCfg: WeaverConfig = { ...monoCfg, edgeDetector: 'NONE' };
      const edgeSobelCfg: WeaverConfig = { ...monoCfg, edgeDetector: 'SOBEL' };
      expect(isControlVisible('edgeBlendWeight', edgeNoneCfg)).toBe(false);
      expect(isControlVisible('edgeBlendWeight', edgeSobelCfg)).toBe(true);

      // 4. Controles geométricos por forma do tear (CIRCULAR vs SQUARE)
      const circCfg: WeaverConfig = { ...monoCfg, shape: 'CIRCULAR' };
      const squareCfg: WeaverConfig = { ...monoCfg, shape: 'SQUARE' };

      expect(isControlVisible('diameterMm', circCfg)).toBe(true);
      expect(isControlVisible('widthMm', circCfg)).toBe(false);

      expect(isControlVisible('widthMm', squareCfg)).toBe(true);
      expect(isControlVisible('diameterMm', squareCfg)).toBe(false);

      // 5. Lista completa de visibilidade
      const visibleSet = getVisibleControls(circCfg);
      expect(visibleSet.has('diameterMm')).toBe(true);
      expect(visibleSet.has('widthMm')).toBe(false);
      expect(visibleSet.has('spoolStrategy')).toBe(false);

      const visibleSquare = getVisibleControls(squareCfg);
      expect(visibleSquare.has('widthMm')).toBe(true);
      expect(visibleSquare.has('diameterMm')).toBe(false);

      expect((visibleSet as unknown as Set<string>).has('fistaIterations')).toBe(false);
      expect((visibleSet as unknown as Set<string>).has('polygonSides')).toBe(false);
      expect((visibleSet as unknown as Set<string>).has('beamWidth')).toBe(false);
      expect((visibleSquare as unknown as Set<string>).has('fistaIterations')).toBe(false);
      expect((visibleSquare as unknown as Set<string>).has('polygonSides')).toBe(false);
      expect((visibleSquare as unknown as Set<string>).has('beamWidth')).toBe(false);
    });
  });
});
