import { createLoom, sideLabel, tangentSegment, type Loom, type WeaveResult } from '@weaver-art/core';

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
    this.storageKey = `weaver-art:progress:${fingerprint(result)}`;

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

    const saved = Number(localStorage.getItem(this.storageKey) ?? 0);
    this.el.empty.hidden = true;
    this.el.live.hidden = false;
    this.el.total.textContent = String(result.steps.length);
    this.el.goto.max = String(result.steps.length);
    this.go(Number.isFinite(saved) ? saved : 0);
  }

  /** Re-render (e.g. when the tab becomes visible and the canvas gets its size). */
  refresh(): void {
    if (this.result) this.go(this.index);
  }

  private go(index: number, speak = false): void {
    const r = this.result;
    if (!r) return;
    this.index = Math.min(Math.max(index, 0), r.steps.length);
    localStorage.setItem(this.storageKey, String(this.index));
    const done = this.index >= r.steps.length;
    const s = done ? null : r.steps[this.index];
    const thread = s ? r.options.threads[s.thread] : null;
    const withSides = r.options.loom.pegDiameterMm > 0;
    const layerInfo = s ? this.stepLayerInfo[this.index] : null;

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
    const margin = 40;
    const k = (W - 2 * margin) / r.options.loom.diameterMm;
    const X = (mm: number): number => margin + mm * k;
    const rad = loom.radiusMm;

    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = r.options.background;
    ctx.beginPath();
    ctx.arc(X(rad), X(rad), rad * k, 0, Math.PI * 2);
    ctx.fill();

    // Thread laid so far.
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

    // Pegs + labels.
    ctx.fillStyle = '#9a958c';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of loom.pegs) {
      ctx.beginPath();
      ctx.arc(X(p.x), X(p.y), 2, 0, Math.PI * 2);
      ctx.fill();
      if ((p.index + PEG_BASE) % 10 === 0 || p.index === 0) {
        const lx = rad + (rad + 22 / k) * Math.cos(p.angle);
        const ly = rad + (rad + 22 / k) * Math.sin(p.angle);
        ctx.fillText(String(p.index + PEG_BASE), X(lx), X(ly));
      }
    }

    // Current chord.
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

/** Cheap stable id for a result, used to persist knitting progress. */
function fingerprint(r: WeaveResult): string {
  let h = 2166136261;
  const feed = (n: number): void => {
    h ^= n;
    h = Math.imul(h, 16777619);
  };
  feed(r.steps.length);
  feed(r.options.loom.pegCount);
  for (const s of r.steps) {
    feed(s.from);
    feed(s.to);
    feed(s.thread);
  }
  return (h >>> 0).toString(36);
}
