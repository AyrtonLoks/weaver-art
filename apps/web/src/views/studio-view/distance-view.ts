/**
 * Vista à distância (rodada "reconhecimento facial").
 *
 * Uma string art é feita para ser vista de longe: de perto o olho enxerga fios
 * individuais; a alguns metros ele integra os fios e o retrato aparece. Esta vista
 * aplica à simulação um desfoque gaussiano equivalente à acuidade visual humana na
 * distância escolhida e, opcionalmente, mostra lado a lado a foto enquadrada com o
 * mesmo desfoque — a comparação que importa para "se reconhecer" na obra.
 *
 * Modelo: σ_mm = d_m · ACUITY_BLUR_MM_PER_M (≈ 2′ de arco, 0,6 mm por metro) e
 * σ_px = σ_mm · (largura CSS do canvas · zoom / extensão do tear em mm).
 *
 * Testável em Node: todo acesso a DOM é protegido.
 */

/** Desfoque equivalente à acuidade visual (~2 minutos de arco): milímetros de σ por metro de distância. */
export const ACUITY_BLUR_MM_PER_M = 0.6;

export type SimViewMode = 'threads' | 'distance';

/** Converte a distância de observação em σ (px CSS) para o canvas exibido. */
export function distanceBlurPx(distanceM: number, cssWidthPx: number, extentMm: number, zoom = 1): number {
  if (!(distanceM > 0) || !(cssWidthPx > 0) || !(extentMm > 0)) return 0;
  const sigmaMm = distanceM * ACUITY_BLUR_MM_PER_M;
  return sigmaMm * ((cssWidthPx * Math.max(zoom, 1e-3)) / extentMm);
}

export interface DistanceViewElements {
  simCanvas: HTMLCanvasElement;
  compareCanvas?: HTMLCanvasElement | null;
  pair?: HTMLElement | null;
  btnThreads?: HTMLButtonElement | null;
  btnDistance?: HTMLButtonElement | null;
  distanceInput?: HTMLInputElement | null;
  distanceOut?: HTMLElement | null;
  compareToggle?: HTMLInputElement | null;
  caption?: HTMLElement | null;
}

export class DistanceViewController {
  private readonly el: DistanceViewElements;
  private readonly getExtentMm: () => number;
  private readonly getZoom: () => number;
  private mode: SimViewMode = 'threads';
  private hasReference = false;
  private stale = false;

  constructor(el: DistanceViewElements, getExtentMm: () => number, getZoom: () => number = () => 1) {
    this.el = el;
    this.getExtentMm = getExtentMm;
    this.getZoom = getZoom;
    this.bindEvents();
    this.refresh();
  }

  public getMode(): SimViewMode {
    return this.mode;
  }

  public getDistanceM(): number {
    const v = Number(this.el.distanceInput?.value);
    return Number.isFinite(v) && v > 0 ? v : 3;
  }

  public setMode(mode: SimViewMode): void {
    this.mode = mode;
    this.el.btnThreads?.classList.toggle('active', mode === 'threads');
    this.el.btnDistance?.classList.toggle('active', mode === 'distance');
    this.refresh();
  }

  public setCompare(enabled: boolean): void {
    if (this.el.compareToggle) this.el.compareToggle.checked = enabled;
    this.refresh();
  }

  /** Remove a foto de referência (troca de foto / sem resultado). */
  public clearReference(): void {
    this.hasReference = false;
    if (this.el.compareToggle) {
      this.el.compareToggle.checked = false;
      this.el.compareToggle.disabled = true;
    }
    this.refresh();
  }

  /** Marca a simulação como não correspondente aos parâmetros atuais. */
  public setStale(stale: boolean): void {
    this.stale = stale;
    if (stale && this.el.compareToggle) {
      this.el.compareToggle.checked = false;
      this.el.compareToggle.disabled = true;
    } else if (!stale && this.hasReference && this.el.compareToggle) {
      this.el.compareToggle.disabled = false;
    }
    this.refresh();
  }

  /** Desenha a foto enquadrada (alvo preparado pelo DSP) no canvas de comparação. */
  public setReference(rgba: Uint8ClampedArray | null, width: number, height: number): void {
    const canvas = this.el.compareCanvas;
    if (!canvas || !rgba || width <= 0 || height <= 0 || rgba.length < width * height * 4) {
      this.hasReference = false;
      this.refresh();
      return;
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const idata = ctx.createImageData(width, height);
    idata.data.set(rgba.subarray(0, width * height * 4));
    ctx.putImageData(idata, 0, 0);
    this.hasReference = true;
    this.stale = false;
    if (this.el.compareToggle) {
      this.el.compareToggle.disabled = false;
    }
    this.refresh();
  }

  /** σ (px CSS) aplicado no modo atual. */
  public currentBlurPx(): number {
    if (this.mode !== 'distance') return 0;
    const cssWidth = this.el.simCanvas.clientWidth || this.el.simCanvas.width;
    return distanceBlurPx(this.getDistanceM(), cssWidth, this.getExtentMm(), this.getZoom());
  }

  public refresh(): void {
    const distance = this.getDistanceM();
    if (this.el.distanceOut) {
      this.el.distanceOut.textContent = `${distance.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} m`;
    }
    const compare = !!this.el.compareToggle?.checked && this.hasReference && !this.stale;
    if (this.el.compareCanvas) this.el.compareCanvas.hidden = !compare;
    this.el.pair?.classList.toggle('compare', compare);

    // A largura do canvas muda com o modo comparação: calcular σ depois do layout.
    const sigma = this.currentBlurPx();
    const filter = sigma > 0.05 ? `blur(${sigma.toFixed(2)}px)` : 'none';
    this.el.simCanvas.style.filter = filter;
    if (this.el.compareCanvas) {
      const cmpWidth = this.el.compareCanvas.clientWidth || this.el.simCanvas.clientWidth;
      const cmpSigma =
        this.mode === 'distance' ? distanceBlurPx(distance, cmpWidth, this.getExtentMm(), this.getZoom()) : 0;
      this.el.compareCanvas.style.filter = cmpSigma > 0.05 ? `blur(${cmpSigma.toFixed(2)}px)` : 'none';
    }

    if (this.el.caption) {
      if (this.stale) {
        this.el.caption.textContent = 'Resultado desatualizado — gere novamente';
        this.el.caption.classList.add('stale');
      } else {
        this.el.caption.classList.remove('stale');
        const base =
          this.mode === 'distance' ? `Vista a ${distance.toLocaleString('pt-BR')} m` : 'Fios em tamanho real';
        this.el.caption.textContent = compare ? `${base} — simulação (esq.) × foto enquadrada (dir.)` : base;
      }
    }
  }

  private bindEvents(): void {
    if (this.el.compareToggle && !this.hasReference) {
      this.el.compareToggle.disabled = true;
    }
    this.el.btnThreads?.addEventListener('click', () => this.setMode('threads'));
    this.el.btnDistance?.addEventListener('click', () => this.setMode('distance'));
    this.el.distanceInput?.addEventListener('input', () => {
      if (this.mode !== 'distance') this.setMode('distance');
      else this.refresh();
    });
    this.el.compareToggle?.addEventListener('change', () => this.refresh());
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this.refresh());
    }
  }
}
