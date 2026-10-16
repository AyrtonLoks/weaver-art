import {
  createLoom,
  estimateWeave,
  formatDuration,
  sideLabel,
  weaveFingerprint,
  type Loom,
  type WeaveResult,
} from '@weaver-art/core';
import { PlayerAudio, type PlayerAudioOptions } from './player-audio.js';
import { PlayerCanvas, type PlayerCanvasOptions } from './player-canvas.js';
import { PlayerProgressCodec } from './player-codec.js';
import { QRCodeGenerator } from './qr-code.js';

export interface PlayerViewElements {
  canvas: HTMLCanvasElement;
  empty: HTMLElement;
  live: HTMLElement;
  step: HTMLElement;
  total: HTMLElement;
  swatch: HTMLElement;
  thread: HTMLElement;
  from: HTMLElement;
  to: HTMLElement;
  side: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  voice: HTMLInputElement;
  auto: HTMLInputElement;
  interval: HTMLInputElement;
  goto: HTMLInputElement;
  bar: HTMLElement;
  remaining?: HTMLElement;
  code?: HTMLInputElement;
  copyCodeBtn?: HTMLButtonElement;
  pasteCodeBtn?: HTMLButtonElement;
  exportResumeBtn?: HTMLButtonElement;
  // Sprint 4 — Task 4.3 additions
  spoolAlert?: HTMLElement;
  spoolAlertText?: HTMLElement;
  spoolAlertDismissBtn?: HTMLButtonElement;
  qrBtn?: HTMLButtonElement;
  qrModal?: HTMLElement;
  qrContainer?: HTMLElement;
  qrCloseBtn?: HTMLButtonElement;
  qrUrlText?: HTMLElement;
}

const PEG_BASE = 1;

export interface StepLayerMetadata {
  layerIndex: number;
  threadName: string;
  stepInLayer: number;
  totalInLayer: number;
}

/**
 * Controller for the physical knitting/weaving assistant (Studio / Mobile / Tablet).
 * Manages physical tangency arcs, adaptive human cadence estimation, hands-free pt-BR voice synthesis,
 * spool change auto-pauses, and device synchronization via QR Code and IndexedDB.
 */
export class PlayerView {
  private result: WeaveResult | null = null;
  private loom: Loom | null = null;
  private index = 0;
  private timer: number | null = null;
  private storageKey = '';

  // Adaptive user cadence telemetry (recent step interval history in ms)
  private stepIntervals: number[] = [];
  private lastStepTimestamp: number | null = null;

  private readonly canvasRenderer: PlayerCanvas;
  private readonly audio: PlayerAudio;
  private stepLayerInfo: StepLayerMetadata[] = [];

  constructor(
    private readonly el: PlayerViewElements,
    options: {
      audioOptions?: PlayerAudioOptions;
      canvasOptions?: PlayerCanvasOptions;
    } = {},
  ) {
    this.canvasRenderer = new PlayerCanvas(el.canvas, options.canvasOptions);
    this.audio = new PlayerAudio({
      voiceEnabled: el.voice ? el.voice.checked : false,
      ...options.audioOptions,
    });

    this.bindEvents();
  }

  private bindEvents(): void {
    const { el } = this;

    el.prev.addEventListener('click', () => this.go(this.index - 1));
    el.next.addEventListener('click', () => this.go(this.index + 1, true));
    el.goto.addEventListener('change', () => this.go(Number(el.goto.value) - 1));

    if (el.voice) {
      el.voice.addEventListener('change', () => {
        this.audio.setVoiceEnabled(el.voice.checked);
      });
    }

    if (el.auto) {
      el.auto.addEventListener('change', () => this.updateTimer());
    }

    if (el.interval) {
      el.interval.addEventListener('change', () => this.updateTimer());
    }

    if (el.copyCodeBtn) {
      el.copyCodeBtn.addEventListener('click', () => {
        if (!this.result) return;
        const code = PlayerProgressCodec.encode(this.result, this.index);
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(code).then(() => {
            const original = el.copyCodeBtn!.textContent;
            el.copyCodeBtn!.textContent = 'Copiado!';
            setTimeout(() => {
              el.copyCodeBtn!.textContent = original;
            }, 1500);
          });
        }
      });
    }

    if (el.pasteCodeBtn) {
      el.pasteCodeBtn.addEventListener('click', () => {
        if (!this.result) return;
        if (typeof window === 'undefined') return;

        const input =
          typeof window.prompt === 'function' ? window.prompt('Cole o código de retomada (ex: WA1-abc-12-xy):') : null;
        if (!input) return;

        const decoded = PlayerProgressCodec.decode(input);
        if (!decoded) {
          if (typeof alert === 'function') alert('Código inválido ou corrompido.');
          return;
        }

        const currentFp = weaveFingerprint(this.result).toLowerCase();
        if (decoded.fingerprint !== currentFp && !decoded.fingerprint.startsWith(currentFp.slice(0, 6))) {
          if (typeof alert === 'function') alert('Este código pertence a outro padrão ou configuração de tear!');
          return;
        }

        this.go(decoded.index, true);
      });
    }

    if (el.exportResumeBtn) {
      el.exportResumeBtn.addEventListener('click', () => {
        if (!this.result) return;
        PlayerProgressCodec.exportResumeJson(this.result, this.index);
      });
    }

    // Spool Alert Dismissal
    if (el.spoolAlertDismissBtn) {
      el.spoolAlertDismissBtn.addEventListener('click', () => {
        this.dismissSpoolAlert();
      });
    }

    // QR Code Synchronization Modal
    if (el.qrBtn) {
      el.qrBtn.addEventListener('click', () => {
        this.openQrModal();
      });
    }

    if (el.qrCloseBtn) {
      el.qrCloseBtn.addEventListener('click', () => {
        this.closeQrModal();
      });
    }

    if (el.qrModal) {
      el.qrModal.addEventListener('click', (e) => {
        if (e.target === el.qrModal) {
          this.closeQrModal();
        }
      });
    }
  }

  /**
   * Keyboard shortcuts — active while the knitting tab is visible.
   */
  handleKey(ev: KeyboardEvent): void {
    if (!this.result) return;
    if (typeof HTMLInputElement !== 'undefined' && ev.target instanceof HTMLInputElement) return;

    if (ev.code === 'Space' || ev.code === 'ArrowRight') {
      ev.preventDefault();
      this.go(this.index + 1, true);
    } else if (ev.code === 'ArrowLeft') {
      ev.preventDefault();
      this.go(this.index - 1);
    } else if (ev.code === 'KeyP' || ev.key === 'p' || ev.key === 'P') {
      ev.preventDefault();
      this.toggleAuto();
    } else if (ev.code === 'Escape') {
      this.closeQrModal();
      this.dismissSpoolAlert();
    }
  }

  /**
   * Toggles hands-free automatic progression on/off.
   */
  toggleAuto(): void {
    if (this.el.auto) {
      this.el.auto.checked = !this.el.auto.checked;
      this.updateTimer();
    }
  }

  /**
   * Loads a generated or imported weaving result into the player.
   */
  load(result: WeaveResult): void {
    this.result = result;
    this.loom = createLoom(result.options.loom);
    this.storageKey = weaveFingerprint(result);
    this.stepIntervals = [];
    this.lastStepTimestamp = null;

    // Persist complete project to IndexedDB asynchronously
    PlayerProgressCodec.saveProject(result).catch(() => {});

    // Precompute layer progression
    const layerTotals = new Map<number, number>();
    for (const s of result.steps) {
      const key = s.layerIndex ?? s.thread;
      layerTotals.set(key, (layerTotals.get(key) ?? 0) + 1);
    }

    const layerProgress = new Map<number, number>();
    this.stepLayerInfo = result.steps.map((s) => {
      const key = s.layerIndex ?? s.thread;
      const stepInLayer = (layerProgress.get(key) ?? 0) + 1;
      layerProgress.set(key, stepInLayer);
      const thread = result.options.threads[s.thread];
      return {
        layerIndex: key,
        threadName: thread ? thread.name : '',
        stepInLayer,
        totalInLayer: layerTotals.get(key) ?? 1,
      };
    });

    // Resolve initial resume step
    const resumeStep = PlayerProgressCodec.resolveInitialStep(result);

    this.el.empty.hidden = true;
    this.el.live.hidden = false;
    this.el.total.textContent = String(result.steps.length);
    this.el.goto.max = String(result.steps.length);

    this.go(resumeStep, false);
  }

  /**
   * Re-renders the current frame (e.g. on window resize or tab switch).
   */
  refresh(): void {
    if (this.result && this.loom) {
      this.canvasRenderer.render(this.result, this.loom, this.index);
    }
  }

  /**
   * Jump to a specific step index.
   */
  go(index: number, speak = false): void {
    const r = this.result;
    if (!r) return;

    const prevIndex = this.index;
    const targetIndex = Math.min(Math.max(index, 0), r.steps.length);

    // Track user cadence when moving forward
    if (targetIndex > prevIndex) {
      const now = Date.now();
      if (this.lastStepTimestamp !== null) {
        const delta = now - this.lastStepTimestamp;
        if (delta >= 500 && delta <= 90000) {
          this.stepIntervals.push(delta);
          if (this.stepIntervals.length > 8) {
            this.stepIntervals.shift();
          }
        }
      }
      this.lastStepTimestamp = now;
    }

    this.index = targetIndex;

    // Save progress to localStorage, IndexedDB, and URL hash
    PlayerProgressCodec.saveProgress(this.storageKey, this.index);

    const done = this.index >= r.steps.length;
    const s = done ? null : r.steps[this.index];
    const thread = s ? r.options.threads[s.thread] : null;
    const withSides = r.options.loom.pegDiameterMm > 0;
    const layerInfo = s ? this.stepLayerInfo[this.index] : null;

    // 1. Dynamic remaining time calculation (adaptive human cadence + core physics fallback)
    if (this.el.remaining) {
      if (done) {
        this.el.remaining.textContent = 'Concluído!';
      } else {
        const remainingSteps = r.steps.length - this.index;
        let estimatedSeconds: number;

        if (this.stepIntervals.length >= 3) {
          const avgIntervalMs = this.stepIntervals.reduce((a, b) => a + b, 0) / this.stepIntervals.length;
          estimatedSeconds = Math.round((remainingSteps * avgIntervalMs) / 1000);
        } else {
          const remainingEst = estimateWeave(r, {}, this.index);
          estimatedSeconds = remainingEst.totalSeconds;
        }

        this.el.remaining.textContent = formatDuration(estimatedSeconds);
      }
    }

    // 2. Synchronize URL hash and resume code
    if (this.el.code) {
      const code = PlayerProgressCodec.encode(r, this.index);
      this.el.code.value = code;
      PlayerProgressCodec.syncUrlHash(code);
    }

    this.el.step.textContent = String(Math.min(this.index + 1, r.steps.length));
    const isLayered = (r.options.colorStrategy ?? 'layered') === 'layered';

    if (layerInfo && r.options.threads.length > 1) {
      if (isLayered) {
        this.el.thread.textContent = `Camada ${layerInfo.layerIndex + 1}: ${layerInfo.threadName} (${layerInfo.stepInLayer}/${layerInfo.totalInLayer})`;
      } else {
        this.el.thread.textContent = `${layerInfo.threadName} (${layerInfo.stepInLayer}/${layerInfo.totalInLayer})`;
      }
    } else {
      this.el.thread.textContent = thread ? thread.name : 'Concluído';
    }

    this.el.swatch.style.background = thread ? thread.color : 'transparent';
    this.el.from.textContent = s ? String(s.from + PEG_BASE) : '—';
    this.el.to.textContent = s ? String(s.to + PEG_BASE) : '✔';
    this.el.side.textContent = s && withSides ? `contornar no sentido ${sideLabel(s.toSide)}` : '';
    this.el.bar.style.width = `${(this.index / Math.max(1, r.steps.length)) * 100}%`;
    this.el.goto.value = String(this.index + 1);
    this.el.prev.disabled = this.index === 0;
    this.el.next.disabled = done;

    // 3. Spool / Layer Change Detection & Automatic Interruption
    let isSpoolSwitch = false;
    let spoolSwitchMessage = '';
    const prevStep = prevIndex >= 0 && prevIndex < r.steps.length ? r.steps[prevIndex] : null;

    if (!done && s && prevStep && targetIndex > prevIndex) {
      if (s.thread !== prevStep.thread || (s.layerIndex !== undefined && s.layerIndex !== prevStep.layerIndex)) {
        isSpoolSwitch = true;
        const prevThreadName = r.options.threads[prevStep.thread]?.name ?? 'Cor Anterior';
        const nextThreadName = thread?.name ?? 'Nova Cor';
        const tiePin = prevStep.to + PEG_BASE;
        spoolSwitchMessage = `Troca de Carretel: Amarre e finalize o fio ${prevThreadName} no pino ${tiePin} e inicie o carretel ${nextThreadName}.`;
      }
    }

    if (isSpoolSwitch) {
      // Pause automatic playback immediately upon spool switch
      this.stopTimer();
      if (this.el.auto) {
        this.el.auto.checked = false;
      }

      // Display alert banner
      if (this.el.spoolAlert && this.el.spoolAlertText) {
        this.el.spoolAlertText.textContent = spoolSwitchMessage;
        this.el.spoolAlert.hidden = false;
      }
    } else if (this.el.spoolAlert && !isSpoolSwitch) {
      this.el.spoolAlert.hidden = true;
    }

    // 4. Render Canvas (includes departure and arrival winding arrows)
    this.canvasRenderer.render(r, this.loom, this.index);

    // 5. Audio Announcements & Hands-free Auto-advance Chain
    if (done) {
      this.stopTimer();
      if (speak) {
        this.audio.dictateStep({ toPeg: 0, isComplete: true });
      }
      return;
    }

    if (s) {
      let layerTransition:
        | { isStart?: boolean; prevThreadName?: string; nextThreadName?: string; prevPin?: number }
        | undefined;

      if (r.options.threads.length > 1) {
        if (isLayered) {
          if (prevStep && prevStep.layerIndex !== s.layerIndex) {
            const prevThread = r.options.threads[prevStep.thread];
            layerTransition = {
              prevThreadName: prevThread ? prevThread.name : '',
              nextThreadName: thread ? thread.name : '',
              prevPin: prevStep.to + PEG_BASE,
            };
          } else if (!prevStep && this.index === 0) {
            layerTransition = {
              isStart: true,
              nextThreadName: thread ? thread.name : '',
            };
          }
        } else {
          if (!prevStep || prevStep.thread !== s.thread) {
            layerTransition = {
              nextThreadName: thread ? thread.name : '',
              prevPin: prevStep ? prevStep.to + PEG_BASE : undefined,
            };
          }
        }
      }

      const sideText = withSides && s.toSide !== undefined ? sideLabel(s.toSide) : undefined;

      // Handle speech and scheduling of next auto-step
      const isAutoActive = this.el.auto && this.el.auto.checked;

      if (speak && this.audio.isVoiceEnabled()) {
        this.audio.dictateStep({
          toPeg: s.to + PEG_BASE,
          sideText,
          layerTransition,
          onEnd: () => {
            // Only begin counting down after voice playback completes!
            if (isAutoActive && !isSpoolSwitch) {
              this.scheduleNextAutoStep();
            }
          },
        });
      } else {
        if (speak) {
          this.audio.dictateStep({
            toPeg: s.to + PEG_BASE,
            sideText,
            layerTransition,
          });
        }
        if (isAutoActive && !isSpoolSwitch) {
          this.scheduleNextAutoStep();
        }
      }
    }
  }

  private updateTimer(): void {
    this.stopTimer();
    if (!this.el.auto || !this.el.auto.checked) return;
    this.scheduleNextAutoStep();
  }

  private scheduleNextAutoStep(): void {
    this.stopTimer();
    if (!this.el.auto || !this.el.auto.checked || !this.result || this.index >= this.result.steps.length) return;

    const ms = Math.max(1, Number(this.el.interval ? this.el.interval.value : 4) || 4) * 1000;
    if (typeof window !== 'undefined') {
      this.timer = window.setTimeout(() => {
        this.go(this.index + 1, true);
      }, ms);
    }
  }

  private stopTimer(): void {
    if (this.timer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.timer);
    }
    this.timer = null;
    if (this.result && this.index >= this.result.steps.length && this.el.auto) {
      this.el.auto.checked = false;
    }
  }

  /**
   * Dismiss the spool change highlight card.
   */
  dismissSpoolAlert(): void {
    if (this.el.spoolAlert) {
      this.el.spoolAlert.hidden = true;
    }
  }

  /**
   * Generates a mobile resumption QR Code SVG and opens the sync modal.
   */
  openQrModal(): void {
    if (!this.result) return;
    const code = PlayerProgressCodec.encode(this.result, this.index);
    const origin =
      typeof window !== 'undefined' && window.location ? window.location.href.split('#')[0] : 'https://weaver.art/';
    const syncUrl = `${origin}#progress=${encodeURIComponent(code)}`;

    if (this.el.qrContainer) {
      const svg = QRCodeGenerator.toSVG(syncUrl, {
        margin: 2,
        fill: '#121210',
        background: '#ffffff',
      });
      this.el.qrContainer.innerHTML = svg;
    }

    if (this.el.qrUrlText) {
      this.el.qrUrlText.textContent = syncUrl;
    }

    if (this.el.qrModal) {
      this.el.qrModal.hidden = false;
    }
  }

  /**
   * Closes the mobile resumption QR Code modal.
   */
  closeQrModal(): void {
    if (this.el.qrModal) {
      this.el.qrModal.hidden = true;
    }
  }

  /**
   * Returns current playback state for unit testing and telemetry.
   */
  getState(): {
    index: number;
    totalSteps: number;
    currentPegFrom: number | null;
    currentPegTo: number | null;
    isDone: boolean;
    hasActiveTimer: boolean;
    recentCadenceMs: number | null;
  } {
    const total = this.result ? this.result.steps.length : 0;
    const s = this.result && this.index < total ? this.result.steps[this.index] : null;
    const avgCadence =
      this.stepIntervals.length > 0
        ? Math.round(this.stepIntervals.reduce((a, b) => a + b, 0) / this.stepIntervals.length)
        : null;

    return {
      index: this.index,
      totalSteps: total,
      currentPegFrom: s ? s.from + PEG_BASE : null,
      currentPegTo: s ? s.to + PEG_BASE : null,
      isDone: this.index >= total,
      hasActiveTimer: this.timer !== null,
      recentCadenceMs: avgCadence,
    };
  }

  destroy(): void {
    this.stopTimer();
    this.audio.stop();
  }
}
