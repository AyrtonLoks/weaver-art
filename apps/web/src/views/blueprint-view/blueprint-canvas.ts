/**
 * Interactive Technical CAD Canvas for Physical Loom Drilling & Manufacturing.
 */

import type { Loom } from '@weaver-art/core';
import type { PaperSize } from './index.js';

export interface BlueprintCanvasOptions {
  drillDiameterMm: number;
  marginMm: number;
  overlapMm: number;
  paper: PaperSize;
  showPrintGrid: boolean;
  showDimensions: boolean;
  showPegNumbers: boolean;
}

export interface FreeWallInspectionInfo {
  pegIndexA: number;
  pegIndexB: number;
  centerDistanceMm: number;
  freeWallMm: number;
  status: 'safe' | 'warning' | 'collision';
  statusLabel: string;
}

export const PAPER_DIMENSIONS_MM: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  Letter: { w: 215.9, h: 279.4 },
};

export class BlueprintCanvas {
  private readonly canvas: HTMLCanvasElement;
  private loom: Loom;
  private options: BlueprintCanvasOptions;

  private scale = 1.0;
  private panX = 0;
  private panY = 0;

  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;

  private hoveredPegIndex: number | null = null;
  private highlightedPegIndex: number | null = null;
  private inspectFreeWallMode = false;

  public onPegHover?: (index: number | null, info?: FreeWallInspectionInfo) => void;
  public onPegSelect?: (index: number, info: FreeWallInspectionInfo) => void;

  constructor(canvas: HTMLCanvasElement, loom: Loom, options: BlueprintCanvasOptions) {
    this.canvas = canvas;
    this.loom = loom;
    this.options = { ...options };

    this.bindEvents();
    this.fitView();
  }

  public setLoom(loom: Loom, options?: Partial<BlueprintCanvasOptions>): void {
    this.loom = loom;
    if (options) {
      this.options = { ...this.options, ...options };
    }
    this.render();
  }

  public updateOptions(options: Partial<BlueprintCanvasOptions>): void {
    this.options = { ...this.options, ...options };
    this.render();
  }

  public getOptions(): Readonly<BlueprintCanvasOptions> {
    return this.options;
  }

  public resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (rect) {
      const targetW = Math.max(300, Math.floor(rect.width));
      const targetH = Math.max(300, Math.floor(rect.height));
      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
        this.render();
      }
    }
  }

  public fitView(): void {
    this.resize();
    const w = this.canvas.width;
    const h = this.canvas.height;
    const totalExtentMm = this.loom.extentMm + 2 * this.options.marginMm + 60;
    this.scale = Math.min(w, h) / totalExtentMm;
    this.panX = w / 2;
    this.panY = h / 2;
    this.inspectFreeWallMode = false;
    this.render();
  }

  public zoomFreeWall(pegIndex = 0): void {
    this.resize();
    const pegs = this.loom.pegs;
    if (pegs.length < 2) return;

    const p0 = pegs[pegIndex % pegs.length];
    const p1 = pegs[(pegIndex + 1) % pegs.length];
    const ox = this.loom.extentMm / 2;
    const oy = this.loom.extentMm / 2;

    const midX = (p0.x + p1.x) / 2 - ox;
    const midY = (p0.y + p1.y) / 2 - oy;

    const w = this.canvas.width;
    const h = this.canvas.height;

    this.scale = Math.min(w, h) / 32;
    this.panX = w / 2 - midX * this.scale;
    this.panY = h / 2 - midY * this.scale;
    this.highlightedPegIndex = p0.index;
    this.inspectFreeWallMode = true;
    this.render();
  }

  public zoomIn(factor = 1.25): void {
    this.scale = Math.min(100.0, this.scale * factor);
    this.render();
  }

  public zoomOut(factor = 1.25): void {
    this.scale = Math.max(0.05, this.scale / factor);
    this.render();
  }

  public highlightPeg(index: number | null): void {
    this.highlightedPegIndex = index;
    if (index !== null) {
      const p = this.loom.pegs[index];
      if (p) {
        const ox = this.loom.extentMm / 2;
        const oy = this.loom.extentMm / 2;
        const xm = p.x - ox;
        const ym = p.y - oy;
        this.panX = this.canvas.width / 2 - xm * this.scale;
        this.panY = this.canvas.height / 2 - ym * this.scale;
      }
    }
    this.render();
  }

  public getInspectedFreeWallInfo(pegIndex?: number): FreeWallInspectionInfo {
    const pegs = this.loom.pegs;
    const n = pegs.length;
    if (n < 2) {
      return {
        pegIndexA: 0,
        pegIndexB: 0,
        centerDistanceMm: 0,
        freeWallMm: 0,
        status: 'safe',
        statusLabel: 'Seguro (sem pinos suficientes)',
      };
    }

    const idx =
      pegIndex !== undefined
        ? pegIndex % n
        : this.hoveredPegIndex !== null
          ? this.hoveredPegIndex % n
          : this.highlightedPegIndex !== null
            ? this.highlightedPegIndex % n
            : 0;

    const pA = pegs[idx];
    const pB = pegs[(idx + 1) % n];

    const dx = pB.x - pA.x;
    const dy = pB.y - pA.y;
    const centerDist = Math.hypot(dx, dy);
    const freeWall = centerDist - this.options.drillDiameterMm;

    let status: 'safe' | 'warning' | 'collision';
    let statusLabel: string;
    if (freeWall >= 1.5) {
      status = 'safe';
      statusLabel = 'Seguro (parede ≥ 1.5 mm)';
    } else if (freeWall > 0.0) {
      status = 'warning';
      statusLabel = 'Alerta Parede Fina (< 1.5 mm)';
    } else {
      status = 'collision';
      statusLabel = 'Erro Colisão de Broca (≤ 0 mm)';
    }

    return {
      pegIndexA: pA.index,
      pegIndexB: pB.index,
      centerDistanceMm: centerDist,
      freeWallMm: freeWall,
      status,
      statusLabel,
    };
  }

  private bindEvents(): void {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.dragStartX = e.clientX - this.panX;
      this.dragStartY = e.clientY - this.panY;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this.isDragging) {
        this.panX = e.clientX - this.dragStartX;
        this.panY = e.clientY - this.dragStartY;
        this.render();
      } else {
        this.handlePointerHover(e);
      }
    });

    const stopDrag = (e: PointerEvent): void => {
      if (this.isDragging) {
        this.isDragging = false;
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
    };

    canvas.addEventListener('pointerup', stopDrag);
    canvas.addEventListener('pointercancel', stopDrag);

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
        const newScale = Math.min(100.0, Math.max(0.05, this.scale * zoomFactor));

        this.panX = mouseX - (mouseX - this.panX) * (newScale / this.scale);
        this.panY = mouseY - (mouseY - this.panY) * (newScale / this.scale);
        this.scale = newScale;
        this.render();
      },
      { passive: false },
    );

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const ox = this.loom.extentMm / 2;
      const oy = this.loom.extentMm / 2;
      const worldX = (mouseX - this.panX) / this.scale;
      const worldY = (mouseY - this.panY) / this.scale;

      const hit = this.findPegAtWorld(worldX, worldY, ox, oy);
      if (hit !== null) {
        this.highlightPeg(hit);
        const info = this.getInspectedFreeWallInfo(hit);
        this.onPegSelect?.(hit, info);
      }
    });
  }

  private handlePointerHover(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const ox = this.loom.extentMm / 2;
    const oy = this.loom.extentMm / 2;
    const worldX = (mouseX - this.panX) / this.scale;
    const worldY = (mouseY - this.panY) / this.scale;

    const hit = this.findPegAtWorld(worldX, worldY, ox, oy);
    if (hit !== this.hoveredPegIndex) {
      this.hoveredPegIndex = hit;
      this.render();
      const info = hit !== null ? this.getInspectedFreeWallInfo(hit) : undefined;
      this.onPegHover?.(hit, info);
    }
  }

  private findPegAtWorld(wx: number, wy: number, ox: number, oy: number): number | null {
    const hitRadius = Math.max(this.options.drillDiameterMm, 12.0 / this.scale);
    let closestIndex: number | null = null;
    let minD = Infinity;

    for (const p of this.loom.pegs) {
      const px = p.x - ox;
      const py = p.y - oy;
      const dist = Math.hypot(wx - px, wy - py);
      if (dist < minD && dist <= hitRadius) {
        minD = dist;
        closestIndex = p.index;
      }
    }

    return closestIndex;
  }

  public render(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const width = this.canvas.width;
    const height = this.canvas.height;

    ctx.fillStyle = '#0f141c';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);

    const ox = this.loom.extentMm / 2;
    const oy = this.loom.extentMm / 2;
    const toWorldX = (x: number): number => x - ox;
    const toWorldY = (y: number): number => y - oy;

    this.drawCadGrid(ctx);

    if (this.options.showPrintGrid) {
      this.drawPaperTiling(ctx, ox, oy);
    }

    this.drawLoomRim(ctx, toWorldX, toWorldY);
    this.drawDrillHoles(ctx, toWorldX, toWorldY);

    if (this.options.showDimensions && this.loom.pegs.length >= 2) {
      this.drawFreeWallCallout(ctx, toWorldX, toWorldY);
    }

    this.drawCenterCrosshair(ctx);
    ctx.restore();

    this.drawHud(ctx, width, height);
  }

  private drawCadGrid(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    const visibleWidthMm = this.canvas.width / this.scale;
    const visibleHeightMm = this.canvas.height / this.scale;
    const minX = -this.panX / this.scale;
    const maxX = minX + visibleWidthMm;
    const minY = -this.panY / this.scale;
    const maxY = minY + visibleHeightMm;

    if (this.scale > 0.4) {
      ctx.strokeStyle = '#18202c';
      ctx.lineWidth = 0.5 / this.scale;
      ctx.beginPath();
      const startX = Math.floor(minX / 10) * 10;
      for (let x = startX; x <= maxX; x += 10) {
        ctx.moveTo(x, minY);
        ctx.lineTo(x, maxY);
      }
      const startY = Math.floor(minY / 10) * 10;
      for (let y = startY; y <= maxY; y += 10) {
        ctx.moveTo(minX, y);
        ctx.lineTo(maxX, y);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = '#222d3d';
    ctx.lineWidth = 1.0 / this.scale;
    ctx.beginPath();
    const startX50 = Math.floor(minX / 50) * 50;
    for (let x = startX50; x <= maxX; x += 50) {
      ctx.moveTo(x, minY);
      ctx.lineTo(x, maxY);
    }
    const startY50 = Math.floor(minY / 50) * 50;
    for (let y = startY50; y <= maxY; y += 50) {
      ctx.moveTo(minX, y);
      ctx.lineTo(maxX, y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(59, 130, 246, 0.45)';
    ctx.lineWidth = 1.0 / this.scale;
    ctx.beginPath();
    ctx.moveTo(minX, 0);
    ctx.lineTo(maxX, 0);
    ctx.moveTo(0, minY);
    ctx.lineTo(0, maxY);
    ctx.stroke();

    ctx.restore();
  }

  private drawPaperTiling(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    const rawPaper = PAPER_DIMENSIONS_MM[this.options.paper] ?? PAPER_DIMENSIONS_MM.A4;
    const printerMarginMm = 10.0;
    const overlapMm = this.options.overlapMm;

    const isLand = this.loom.widthMm > this.loom.heightMm;
    const paperW = isLand ? Math.max(rawPaper.w, rawPaper.h) : Math.min(rawPaper.w, rawPaper.h);
    const paperH = isLand ? Math.min(rawPaper.w, rawPaper.h) : Math.max(rawPaper.w, rawPaper.h);

    const printW = Math.max(10, paperW - 2 * printerMarginMm);
    const printH = Math.max(10, paperH - 2 * printerMarginMm);

    const stepX = Math.max(5, printW - overlapMm);
    const stepY = Math.max(5, printH - overlapMm);

    const halfRim = this.options.marginMm;
    const pitchR = this.loom.radiusMm;
    const outerR = pitchR + halfRim;
    const innerR = Math.max(0, pitchR - halfRim);

    const bbMinX = -outerR;
    const bbMaxX = outerR;
    const bbMinY = -outerR;
    const bbMaxY = outerR;
    const bbW = bbMaxX - bbMinX;
    const bbH = bbMaxY - bbMinY;

    const numCols = bbW <= printW ? 1 : 1 + Math.ceil((bbW - printW) / stepX);
    const numRows = bbH <= printH ? 1 : 1 + Math.ceil((bbH - printH) / stepY);

    const gridTotalW = printW + (numCols - 1) * stepX;
    const gridTotalH = printH + (numRows - 1) * stepY;

    const startX = bbMinX - (gridTotalW - bbW) / 2;
    const startY = bbMinY - (gridTotalH - bbH) / 2;

    ctx.save();
    // Fonte em tamanho constante de ecrã (10px) sem explodir quando fazemos zoom out!
    const fontWorldSize = 10.0 / this.scale;
    ctx.font = `600 ${fontWorldSize}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (let r = 0; r < numRows; r++) {
      const rowLetter = String.fromCharCode(65 + (r % 26));
      for (let c = 0; c < numCols; c++) {
        const sheetCode = `${rowLetter}${c + 1}`;
        const x0 = startX + c * stepX;
        const x1 = x0 + printW;
        const y0 = startY + r * stepY;
        const y1 = y0 + printH;

        let pinCount = 0;
        for (const p of this.loom.pegs) {
          const wx = p.x - ox;
          const wy = p.y - oy;
          if (wx >= x0 && wx <= x1 && wy >= y0 && wy <= y1) {
            pinCount++;
          }
        }

        const corners = [
          [x0, y0],
          [x1, y0],
          [x0, y1],
          [x1, y1],
        ];
        let dMax = 0;
        for (const [cx, cy] of corners) {
          const d = Math.hypot(cx, cy);
          if (d > dMax) dMax = d;
        }

        const dxMin = 0 < x0 ? x0 : 0 > x1 ? -x1 : 0;
        const dyMin = 0 < y0 ? y0 : 0 > y1 ? -y1 : 0;
        const dMin = Math.hypot(dxMin, dyMin);

        const isEmptyInterior = innerR > 1.0 && dMax < innerR && pinCount === 0;
        const isEmptyExterior = dMin > outerR && pinCount === 0;
        const isActive = !isEmptyInterior && !isEmptyExterior;

        if (isEmptyInterior) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
          ctx.lineWidth = 0.7 / this.scale;
          ctx.setLineDash([4 / this.scale, 4 / this.scale]);
          ctx.strokeRect(x0, y0, printW, printH);
          ctx.setLineDash([]);

          // Etiqueta discreta no canto superior esquerdo (nunca no centro onde fica a cota Ø Primitivo!)
          if (this.scale >= 0.32) {
            const pad = 4 / this.scale;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
            ctx.fillRect(x0 + pad, y0 + pad, 68 / this.scale, 16 / this.scale);
            ctx.fillStyle = '#64748b';
            ctx.fillText(`${sheetCode} (Vazio)`, x0 + pad * 2, y0 + pad * 1.5);
          }
        } else if (isActive) {
          ctx.fillStyle = 'rgba(14, 165, 233, 0.04)';
          ctx.fillRect(x0, y0, printW, printH);

          ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
          ctx.lineWidth = 1.0 / this.scale;
          ctx.setLineDash([5 / this.scale, 3 / this.scale]);
          ctx.strokeRect(x0, y0, printW, printH);
          ctx.setLineDash([]);

          if (overlapMm > 0) {
            ctx.fillStyle = 'rgba(56, 189, 248, 0.07)';
            if (c + 1 < numCols) {
              ctx.fillRect(x1 - overlapMm, y0, overlapMm, printH);
            }
            if (r + 1 < numRows) {
              ctx.fillRect(x0, y1 - overlapMm, printW, overlapMm);
            }
          }

          // Pílula de etiqueta limpa no canto superior esquerdo da folha
          const pad = 5 / this.scale;
          const badgeW = 92 / this.scale;
          const badgeH = 18 / this.scale;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
          ctx.fillRect(x0 + pad, y0 + pad, badgeW, badgeH);
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
          ctx.lineWidth = 0.8 / this.scale;
          ctx.strokeRect(x0 + pad, y0 + pad, badgeW, badgeH);

          ctx.fillStyle = '#38bdf8';
          ctx.fillText(
            `${sheetCode} · ${pinCount} furos`,
            x0 + pad + 4 / this.scale,
            y0 + pad + 3 / this.scale,
          );
        }
      }
    }

    ctx.restore();
  }

  private drawLoomRim(
    ctx: CanvasRenderingContext2D,
    toWorldX: (x: number) => number,
    toWorldY: (y: number) => number,
  ): void {
    ctx.save();
    const margin = this.options.marginMm;
    const rPrim = this.loom.radiusMm;
    const rOuter = rPrim + margin;
    const rInner = Math.max(5, rPrim - margin);

    const shape = this.loom.config.shape;

    if (shape === 'circle') {
      ctx.fillStyle = 'rgba(30, 41, 59, 0.45)';
      ctx.beginPath();
      ctx.arc(0, 0, rOuter, 0, Math.PI * 2);
      ctx.arc(0, 0, rInner, 0, Math.PI * 2, true);
      ctx.fill();

      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 2.0 / this.scale;
      ctx.beginPath();
      ctx.arc(0, 0, rOuter, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1.2 / this.scale;
      ctx.setLineDash([6 / this.scale, 4 / this.scale]);
      ctx.beginPath();
      ctx.arc(0, 0, rPrim, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.0 / this.scale;
      ctx.beginPath();
      ctx.arc(0, 0, rInner, 0, Math.PI * 2);
      ctx.stroke();

      if (this.options.showDimensions) {
        const fontSz = 11.5 / this.scale;
        ctx.font = `bold ${fontSz}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const label = `Ø Primitivo ${(2 * rPrim).toFixed(1)} mm`;
        const boxW = 148 / this.scale;
        const boxH = 22 / this.scale;
        const cy = 22 / this.scale;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
        ctx.fillRect(-boxW / 2, cy - boxH / 2, boxW, boxH);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.0 / this.scale;
        ctx.strokeRect(-boxW / 2, cy - boxH / 2, boxW, boxH);

        ctx.fillStyle = '#f59e0b';
        ctx.fillText(label, 0, cy);
      }
    } else if (this.loom.outline && this.loom.outline.length > 2) {
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1.5 / this.scale;
      ctx.setLineDash([6 / this.scale, 4 / this.scale]);
      ctx.beginPath();
      this.loom.outline.forEach((pt, i) => {
        const wx = toWorldX(pt.x);
        const wy = toWorldY(pt.y);
        if (i === 0) ctx.moveTo(wx, wy);
        else ctx.lineTo(wx, wy);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  private drawDrillHoles(
    ctx: CanvasRenderingContext2D,
    toWorldX: (x: number) => number,
    toWorldY: (y: number) => number,
  ): void {
    const drillR = this.options.drillDiameterMm / 2;
    const baseScale = this.scale;
    const pegs = this.loom.pegs;
    const n = pegs.length;

    ctx.save();
    ctx.font = `${9.5 / baseScale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Nível de Detalhe (LOD): só mostra todos os números quando o zoom é suficiente para não colidir
    const showAllNumbers = baseScale >= 1.15 || this.inspectFreeWallMode;
    const majorStep = baseScale < 0.45 ? 20 : 10;

    for (const p of pegs) {
      const wx = toWorldX(p.x);
      const wy = toWorldY(p.y);
      const isHovered = this.hoveredPegIndex === p.index;
      const isHighlighted = this.highlightedPegIndex === p.index;
      const isNeighbor =
        this.hoveredPegIndex !== null &&
        ((this.hoveredPegIndex + 1) % n === p.index || (p.index + 1) % n === this.hoveredPegIndex);
      const isMajor = (p.index + 1) % majorStep === 0 || p.index === 0;

      ctx.beginPath();
      ctx.arc(wx, wy, drillR, 0, Math.PI * 2);
      ctx.fillStyle = isHovered
        ? '#0284c7'
        : isHighlighted
          ? '#f43f5e'
          : isNeighbor
            ? '#0369a1'
            : '#1e293b';
      ctx.fill();

      ctx.strokeStyle = isHovered
        ? '#38bdf8'
        : isHighlighted
          ? '#fda4af'
          : isMajor
            ? '#ff5a36'
            : isNeighbor
              ? '#7dd3fc'
              : '#94a3b8';
      ctx.lineWidth = (isHovered || isHighlighted ? 2.0 : 0.8) / baseScale;
      ctx.stroke();

      if (
        this.options.showPegNumbers &&
        (showAllNumbers || isMajor || isHovered || isHighlighted || isNeighbor)
      ) {
        const dist = drillR + 10.0 / baseScale;
        const lx = wx + p.nx * dist;
        const ly = wy + p.ny * dist;

        ctx.fillStyle = isHovered
          ? '#38bdf8'
          : isHighlighted
            ? '#fda4af'
            : isMajor
              ? '#ff5a36'
              : '#cbd5e1';
        ctx.fillText(String(p.index + 1), lx, ly);
      }
    }

    ctx.restore();
  }

  private drawFreeWallCallout(
    ctx: CanvasRenderingContext2D,
    toWorldX: (x: number) => number,
    toWorldY: (y: number) => number,
  ): void {
    const info = this.getInspectedFreeWallInfo();
    const pA = this.loom.pegs[info.pegIndexA];
    const pB = this.loom.pegs[info.pegIndexB];

    const w0x = toWorldX(pA.x);
    const w0y = toWorldY(pA.y);
    const w1x = toWorldX(pB.x);
    const w1y = toWorldY(pB.y);

    const drillR = this.options.drillDiameterMm / 2;
    const dx = w1x - w0x;
    const dy = w1y - w0y;
    const linearPitch = info.centerDistanceMm;
    const freeWall = info.freeWallMm;

    if (linearPitch <= 0) return;

    ctx.save();

    const ux = dx / linearPitch;
    const uy = dy / linearPitch;
    const edge0x = w0x + ux * drillR;
    const edge0y = w0y + uy * drillR;
    const edge1x = w1x - ux * drillR;
    const edge1y = w1y - uy * drillR;

    const wallColor =
      info.status === 'safe' ? '#22c55e' : info.status === 'warning' ? '#eab308' : '#ef4444';

    ctx.strokeStyle = wallColor;
    ctx.lineWidth = 2.5 / this.scale;
    ctx.beginPath();
    ctx.moveTo(edge0x, edge0y);
    ctx.lineTo(edge1x, edge1y);
    ctx.stroke();

    const midX = (w0x + w1x) / 2;
    const midY = (w0y + w1y) / 2;
    const offsetDist = 26.0 / this.scale;
    const labelX = midX + pA.nx * offsetDist;
    const labelY = midY + pA.ny * offsetDist;

    ctx.font = `bold ${11.0 / this.scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const textStr = `Pinos ${pA.index + 1}↔${pB.index + 1} | Passo: ${linearPitch.toFixed(2)} mm | Parede: ${freeWall.toFixed(2)} mm`;
    const boxW = 240 / this.scale;
    const boxH = 22 / this.scale;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
    ctx.fillRect(labelX - boxW / 2, labelY - boxH / 2, boxW, boxH);
    ctx.strokeStyle = wallColor;
    ctx.lineWidth = 1.2 / this.scale;
    ctx.strokeRect(labelX - boxW / 2, labelY - boxH / 2, boxW, boxH);

    ctx.fillStyle = wallColor;
    ctx.fillText(textStr, labelX, labelY);

    ctx.restore();
  }

  private drawCenterCrosshair(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.0 / this.scale;
    const len = 8 / this.scale;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.lineTo(len, 0);
    ctx.moveTo(0, -len);
    ctx.lineTo(0, len);
    ctx.stroke();
    ctx.restore();
  }

  private drawHud(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.save();
    ctx.fillStyle = 'rgba(15, 20, 28, 0.90)';
    ctx.fillRect(8, height - 36, 290, 28);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(8, height - 36, 290, 28);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const zoomPct = Math.round(this.scale * 100);
    ctx.fillText(
      `CAM Zoom: ${zoomPct}% | Pinos: ${this.loom.pegs.length} | Ø: ${this.options.drillDiameterMm.toFixed(1)}mm`,
      16,
      height - 22,
    );
    ctx.restore();
  }
}
