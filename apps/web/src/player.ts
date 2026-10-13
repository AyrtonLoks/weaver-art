import {
  createLoom,
  decodeProgressCode,
  encodeProgressCode,
  estimateWeave,
  formatDuration,
  mergeProgress,
  sideLabel,
  tangentSegment,
  weaveFingerprint,
  withProgress,
  type Loom,
  type WeaveProgress,
  type WeaveResult,
} from '@weaver-art/core';

interface PlayerElements {
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
}

const PEG_BASE = 1;

/**
 * Knitting mode: dictates the pattern one chord at a time, as the computer did for Vrellis.
 * Shows the loom with the thread laid so far and the next chord highlighted.
 */
export class KnitPlayer {
  private result: WeaveResult | null = null;
  private loom: Loom | null = null;
  private index = 0;
  private timer: number | null = null;
  private storageKey = '';

  private stepLayerInfo: { layerIndex: number; threadName: string; stepInLayer: number; totalInLayer: number }[] = [];

  constructor(private readonly el: PlayerElements) {
    el.prev.addEventListener('click', () => this.go(this.index - 1));
    el.next.addEventListener('click', () => this.go(this.index + 1, true));
    el.goto.addEventListener('change', () => this.go(Number(el.goto.value) - 1));
    el.auto.addEventListener('change', () => this.updateTimer());
    el.interval.addEventListener('change', () => this.updateTimer());

    if (el.copyCodeBtn) {
      el.copyCodeBtn.addEventListener('click', () => {
        if (!this.result) return;
        const code = encodeProgressCode(this.result, this.index);
        navigator.clipboard?.writeText(code).then(() => {
          const original = el.copyCodeBtn!.textContent;
          el.copyCodeBtn!.textContent = 'Copiado!';
          setTimeout(() => {
            el.copyCodeBtn!.textContent = original;
          }, 1500);
        });
      });
    }

    if (el.pasteCodeBtn) {
      el.pasteCodeBtn.addEventListener('click', () => {
        if (!this.result) return;
        const input = window.prompt('Cole o código de retomada (ex: WA1-abc-12-xy):');
        if (!input) return;
        const decoded = decodeProgressCode(input);
        if (!decoded) {
          alert('Código inválido ou corrompido.');
          return;
        }
        if (decoded.fingerprint !== weaveFingerprint(this.result)) {
          alert('Este código pertence a outro padrão ou configuração de tear!');
          return;
        }
        this.go(decoded.index);
      });
    }

    if (el.exportResumeBtn) {
      el.exportResumeBtn.addEventListener('click', () => {
        if (!this.result) return;
        const updated = withProgress(this.result, this.index);
        const blob = new Blob([JSON.stringify(updated)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `retomada-passo-${this.index + 1}.weave.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    }
  }

  /** Keyboard shortcuts — only active while the knitting tab is visible. */
  handleKey(ev: KeyboardEvent): void {
    if (!this.result || ev.target instanceof HTMLInputElement) return;
    if (ev.code === 'Space' || ev.code === 'ArrowRight') {
      ev.preventDefault();
      this.go(this.index + 1, true);
    } else if (ev.code === 'ArrowLeft') {
      ev.preventDefault();
      this.go(this.index - 1);
    }
  }

  load(result: WeaveResult): void {
    this.result = result;
    this.loom = createLoom(result.options.loom);
    this.storageKey = `weaver-art:progress:${weaveFingerprint(result)}`;

    // Precompute layer progress for each step
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

    // Determine initial resume position: URL hash > mergeProgress(localStorage, result.progress)
    let resumeStep: number | null = null;
    if (window.location.hash.startsWith('#progress=')) {
      const code = decodeURIComponent(window.location.hash.slice('#progress='.length));
      const decoded = decodeProgressCode(code);
      if (decoded && decoded.fingerprint === weaveFingerprint(result)) {
        resumeStep = decoded.index;
      }
    }
    if (resumeStep === null) {
      const localRaw = localStorage.getItem(this.storageKey);
      let localProgress: WeaveProgress | undefined;
      if (localRaw) {
        try {
          const parsed = JSON.parse(localRaw) as WeaveProgress;
          if (parsed && typeof parsed.index === 'number') {
            localProgress = parsed;
          }
        } catch {
          const numVal = Number(localRaw);
          if (Number.isFinite(numVal)) {
            localProgress = { index: numVal, updatedAt: new Date(0).toISOString() };
          }
        }
      }
      const merged = mergeProgress(localProgress, result.progress);
      resumeStep = merged?.index ?? 0;
    }

    this.el.empty.hidden = true;
    this.el.live.hidden = false;
    this.el.total.textContent = String(result.steps.length);
    this.el.goto.max = String(result.steps.length);
    this.go(resumeStep);
  }

  /** Re-render (e.g. when the tab becomes visible and the canvas gets its size). */
  refresh(): void {
    if (this.result) this.go(this.index);
  }

  private go(index: number, speak = false): void {
    const r = this.result;
    if (!r) return;
    this.index = Math.min(Math.max(index, 0), r.steps.length);
    const progressData: WeaveProgress = {
      index: this.index,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(this.storageKey, JSON.stringify(progressData));
    const done = this.index >= r.steps.length;
    const s = done ? null : r.steps[this.index];
    const thread = s ? r.options.threads[s.thread] : null;
    const withSides = r.options.loom.pegDiameterMm > 0;
    const layerInfo = s ? this.stepLayerInfo[this.index] : null;

    if (this.el.remaining) {
      const remainingEst = estimateWeave(r, {}, this.index);
      this.el.remaining.textContent = done ? 'Concluído!' : formatDuration(remainingEst.totalSeconds);
    }

    if (this.el.code) {
      const code = encodeProgressCode(r, this.index);
      this.el.code.value = code;
      try {
        window.history.replaceState(null, '', `#progress=${encodeURIComponent(code)}`);
      } catch {
        // ignore history restriction in iframe or local contexts
      }
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
    this.draw();

    if (speak && s && this.el.voice.checked) {
      const prev = this.index > 0 ? r.steps[this.index - 1] : null;
      const parts: string[] = [];
      if (r.options.threads.length > 1) {
        if (isLayered) {
          if (prev && prev.layerIndex !== s.layerIndex) {
            const prevThread = r.options.threads[prev.thread];
            parts.push(`Camada ${prevThread.name} concluída. Troque para o fio ${thread?.name ?? ''}`);
          } else if (!prev) {
            parts.push(`Iniciando camada ${thread?.name ?? ''}`);
          }
        } else {
          if (!prev || prev.thread !== s.thread) {
            parts.push(`fio ${thread?.name ?? ''}`);
          }
        }
      }
      parts.push(String(s.to + PEG_BASE));
      if (withSides) parts.push(sideLabel(s.toSide));
      sayAloud(parts.join(', '));
    }
    if (done) this.stopTimer();
  }

  private updateTimer(): void {
    this.stopTimer();
    if (!this.el.auto.checked) return;
    const ms = Math.max(1, Number(this.el.interval.value) || 4) * 1000;
    this.timer = window.setInterval(() => this.go(this.index + 1, true), ms);
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.result && this.index >= this.result.steps.length) this.el.auto.checked = false;
  }

  private draw(): void {
    const r = this.result;
    const loom = this.loom;
    if (!r || !loom) return;
    const canvas = this.el.canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const margin = 45;
    const extent = loom.extentMm;
    const k = (W - 2 * margin) / extent;
    const X = (mm: number): number => margin + mm * k;

    ctx.clearRect(0, 0, W, W);

    // Frame/background
    ctx.fillStyle = r.options.background;
    if (loom.config.shape === 'circle') {
      const cx = loom.extentMm / 2;
      const cy = loom.extentMm / 2;
      ctx.beginPath();
      ctx.arc(X(cx), X(cy), loom.radiusMm * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#3a3835';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (loom.outline && loom.outline.length > 2) {
      ctx.beginPath();
      for (let i = 0; i < loom.outline.length; i++) {
        const pt = loom.outline[i];
        if (i === 0) ctx.moveTo(X(pt.x), X(pt.y));
        else ctx.lineTo(X(pt.x), X(pt.y));
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#3a3835';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillRect(margin, margin, W - 2 * margin, W - 2 * margin);
    }

    // Thread laid so far
    ctx.lineWidth = Math.max(0.35, r.options.threads[0].widthMm * k);
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < this.index && i < r.steps.length; i++) {
      const s = r.steps[i];
      const seg = tangentSegment(loom.pegs[s.from], s.fromSide, loom.pegs[s.to], s.toSide, loom.pegRadiusMm);
      ctx.strokeStyle = r.options.threads[s.thread].color;
      ctx.beginPath();
      ctx.moveTo(X(seg.x0), X(seg.y0));
      ctx.lineTo(X(seg.x1), X(seg.y1));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Pegs + labels
    ctx.fillStyle = '#9a958c';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const totalPegs = loom.pegs.length;
    const labelStep = totalPegs > 100 ? 10 : 5;
    for (const p of loom.pegs) {
      ctx.beginPath();
      ctx.arc(X(p.x), X(p.y), 2.5, 0, Math.PI * 2);
      ctx.fill();
      if ((p.index + PEG_BASE) % labelStep === 0 || p.index === 0) {
        const lx = p.x + p.nx * (18 / k);
        const ly = p.y + p.ny * (18 / k);
        ctx.fillText(String(p.index + PEG_BASE), X(lx), X(ly));
      }
    }

    // Current chord
    const s = r.steps[this.index];
    if (s) {
      const a = loom.pegs[s.from];
      const b = loom.pegs[s.to];
      ctx.strokeStyle = '#ff5a36';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(X(a.x), X(a.y));
      ctx.lineTo(X(b.x), X(b.y));
      ctx.stroke();
      for (const [p, color] of [
        [a, '#ffd166'],
        [b, '#ff5a36'],
      ] as const) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(X(p.x), X(p.y), 7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function sayAloud(text: string): void {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pt-BR';
  u.rate = 1;
  window.speechSynthesis.speak(u);
}
