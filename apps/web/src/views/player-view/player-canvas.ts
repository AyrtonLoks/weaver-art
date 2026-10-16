import { type Loom, type PegSide, type WeaveResult, tangentSegment } from '@weaver-art/core';

const PEG_BASE = 1;

export interface PlayerCanvasOptions {
  marginPx?: number;
  showPegLabels?: boolean;
  activeChordWidthPx?: number;
  highlightHaloRadiusPx?: number;
}

/**
 * High-clarity 2D vector canvas renderer for the step-by-step weaving assistant.
 * Displays the loom silhouette, threads laid so far, active chord, peg numbers,
 * and unambiguous clockwise/counter-clockwise winding arcs on the target pin.
 */
export class PlayerCanvas {
  private readonly margin: number;
  private readonly showPegLabels: boolean;
  private readonly activeChordWidth: number;
  private readonly highlightHaloRadius: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: PlayerCanvasOptions = {},
  ) {
    this.margin = options.marginPx ?? 45;
    this.showPegLabels = options.showPegLabels ?? true;
    this.activeChordWidth = options.activeChordWidthPx ?? 3.5;
    this.highlightHaloRadius = options.highlightHaloRadiusPx ?? 8;
  }

  /**
   * Render the loom state at the specified step index.
   */
  render(result: WeaveResult | null, loom: Loom | null, currentIndex: number): void {
    if (!result || !loom) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const W = this.canvas.width;
    const H = this.canvas.height;
    const extent = Math.max(1, loom.extentMm);
    const k = (Math.min(W, H) - 2 * this.margin) / extent;
    const offsetX = (W - extent * k) / 2;
    const offsetY = (H - extent * k) / 2;

    const toX = (mm: number): number => offsetX + mm * k;
    const toY = (mm: number): number => offsetY + mm * k;

    // Clear background
    ctx.clearRect(0, 0, W, H);

    // 1. Loom perimeter and frame fill
    ctx.save();
    ctx.fillStyle = result.options.background || '#121210';
    if (loom.config.shape === 'circle') {
      const cx = loom.extentMm / 2;
      const cy = loom.extentMm / 2;
      ctx.beginPath();
      ctx.arc(toX(cx), toY(cy), loom.radiusMm * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#3a3835';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (loom.outline && loom.outline.length > 2) {
      ctx.beginPath();
      for (let i = 0; i < loom.outline.length; i++) {
        const pt = loom.outline[i];
        if (i === 0) ctx.moveTo(toX(pt.x), toY(pt.y));
        else ctx.lineTo(toX(pt.x), toY(pt.y));
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#3a3835';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillRect(this.margin, this.margin, W - 2 * this.margin, H - 2 * this.margin);
      ctx.strokeStyle = '#3a3835';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(this.margin, this.margin, W - 2 * this.margin, H - 2 * this.margin);
    }
    ctx.restore();

    // 2. Previously laid threads (from step 0 up to currentIndex - 1)
    const threadWidth = result.options.threads[0]?.widthMm ?? 0.2;
    ctx.lineWidth = Math.max(0.35, threadWidth * k);
    ctx.globalAlpha = 0.55;

    for (let i = 0; i < currentIndex && i < result.steps.length; i++) {
      const s = result.steps[i];
      const fromPeg = loom.pegs[s.from];
      const toPeg = loom.pegs[s.to];
      if (!fromPeg || !toPeg) continue;
      const seg = tangentSegment(fromPeg, s.fromSide, toPeg, s.toSide, loom.pegRadiusMm);
      const threadColor = result.options.threads[s.thread]?.color ?? '#ffffff';
      ctx.strokeStyle = threadColor;
      ctx.beginPath();
      ctx.moveTo(toX(seg.x0), toY(seg.y0));
      ctx.lineTo(toX(seg.x1), toY(seg.y1));
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;

    // 3. Pegs and Numbers
    ctx.fillStyle = '#9a958c';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const totalPegs = loom.pegs.length;
    const labelStep = totalPegs > 150 ? 10 : totalPegs > 60 ? 5 : 2;

    for (const p of loom.pegs) {
      const px = toX(p.x);
      const py = toY(p.y);
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();

      if (this.showPegLabels && ((p.index + PEG_BASE) % labelStep === 0 || p.index === 0)) {
        const distMm = 18 / k;
        const lx = p.x + p.nx * distMm;
        const ly = p.y + p.ny * distMm;
        ctx.fillText(String(p.index + PEG_BASE), toX(lx), toY(ly));
      }
    }

    // 4. Current Chord and Active / Target Pegs
    if (currentIndex < result.steps.length) {
      const s = result.steps[currentIndex];
      const fromPeg = loom.pegs[s.from];
      const toPeg = loom.pegs[s.to];

      if (fromPeg && toPeg) {
        const seg = tangentSegment(fromPeg, s.fromSide, toPeg, s.toSide, loom.pegRadiusMm);
        const x0 = toX(seg.x0);
        const y0 = toY(seg.y0);
        const x1 = toX(seg.x1);
        const y1 = toY(seg.y1);

        // Halo / Glow behind current chord
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 90, 54, 0.35)';
        ctx.lineWidth = this.activeChordWidth + 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();

        // Main chord line
        ctx.strokeStyle = '#ff5a36';
        ctx.lineWidth = this.activeChordWidth;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.restore();

        // From Peg Highlight (Golden circle)
        const fx = toX(fromPeg.x);
        const fy = toY(fromPeg.y);
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(fx, fy, this.highlightHaloRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#2b2a27';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Punch crosshair on from peg
        ctx.strokeStyle = '#2b2a27';
        ctx.beginPath();
        ctx.moveTo(fx - 4, fy);
        ctx.lineTo(fx + 4, fy);
        ctx.moveTo(fx, fy - 4);
        ctx.lineTo(fx, fy + 4);
        ctx.stroke();

        // To Peg Highlight (Vibrant Red-Orange halo)
        const tx = toX(toPeg.x);
        const ty = toY(toPeg.y);
        ctx.fillStyle = '#ff5a36';
        ctx.beginPath();
        ctx.arc(tx, ty, this.highlightHaloRadius + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Punch crosshair on to peg
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(tx - 5, ty);
        ctx.lineTo(tx + 5, ty);
        ctx.moveTo(tx, ty - 5);
        ctx.lineTo(tx, ty + 5);
        ctx.stroke();

        // Peg numbers with badges next to active pegs
        this.renderPegBadge(
          ctx,
          String(fromPeg.index + PEG_BASE),
          fx,
          fy,
          fromPeg.nx,
          fromPeg.ny,
          '#ffd166',
          '#1a1918',
        );
        this.renderPegBadge(ctx, String(toPeg.index + PEG_BASE), tx, ty, toPeg.nx, toPeg.ny, '#ff5a36', '#ffffff');

        // Winding direction indicator (CW / CCW) on departure peg (fromPeg)
        if (s.fromSide !== undefined && loom.pegRadiusMm > 0) {
          this.renderWindingArrow(ctx, fx, fy, s.fromSide, this.highlightHaloRadius + 7, '#ffd166');
        }

        // Winding direction indicator (CW / CCW) on target peg (toPeg)
        if (s.toSide !== undefined && loom.pegRadiusMm > 0) {
          this.renderWindingArrow(ctx, tx, ty, s.toSide, this.highlightHaloRadius + 7, '#ff5a36');
        }
      }
    }
  }

  /**
   * Draws a clear high-contrast badge for the active pin numbers.
   */
  private renderPegBadge(
    ctx: CanvasRenderingContext2D,
    text: string,
    px: number,
    py: number,
    nx: number,
    ny: number,
    bg: string,
    fg: string,
  ): void {
    const dist = 24;
    const bx = px + nx * dist;
    const by = py + ny * dist;

    ctx.save();
    ctx.font = 'bold 12px system-ui, sans-serif';
    const textWidth = typeof ctx.measureText === 'function' ? ctx.measureText(text).width : text.length * 7;
    const padX = 6;
    const h = 18;
    const w = Math.max(20, textWidth + padX * 2);

    ctx.fillStyle = bg;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(bx - w / 2, by - h / 2, w, h, 4);
    } else {
      ctx.rect(bx - w / 2, by - h / 2, w, h);
    }
    ctx.fill();
    ctx.strokeStyle = '#121210';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx, by);
    ctx.restore();
  }

  /**
   * Draws an intuitive curved arrow around a peg indicating Clockwise (CW) or Counter-Clockwise (CCW) winding.
   */
  private renderWindingArrow(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    side: PegSide | 'left' | 'right',
    radius: number,
    color = '#ffd166',
  ): void {
    // PegSide: -1 = Clockwise (horário), 1 = Counter-Clockwise (anti-horário)
    const isCW = side === 'right' || side === -1;
    const startAngle = isCW ? -Math.PI * 0.75 : Math.PI * 0.75;
    const endAngle = isCW ? Math.PI * 0.4 : -Math.PI * 0.4;
    const counterClockwise = !isCW;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, endAngle, counterClockwise);
    ctx.stroke();

    // Arrowhead at endAngle
    const arrowX = cx + radius * Math.cos(endAngle);
    const arrowY = cy + radius * Math.sin(endAngle);
    const tangentAngle = endAngle + (isCW ? Math.PI / 2 : -Math.PI / 2);

    const headLen = 6;
    ctx.beginPath();
    ctx.moveTo(arrowX, arrowY);
    ctx.lineTo(
      arrowX - headLen * Math.cos(tangentAngle - Math.PI / 6),
      arrowY - headLen * Math.sin(tangentAngle - Math.PI / 6),
    );
    ctx.lineTo(
      arrowX - headLen * Math.cos(tangentAngle + Math.PI / 6),
      arrowY - headLen * Math.sin(tangentAngle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
