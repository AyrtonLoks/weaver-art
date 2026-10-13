import { createLoom, loomPegCount } from './geometry.js';
import { PdfDocument } from './pdf.js';
import type { LoomConfig } from './types.js';

export interface TemplateSvgOptions {
  /** Margin around the template boundary in mm (default: 25). */
  marginMm?: number;
  /** Drill diameter in mm (default: loom.pegDiameterMm or 2). */
  drillDiameterMm?: number;
  /** Base peg number for labels (default: 1). */
  pegNumberBase?: number;
}

export type PaperSize = 'A4' | 'A3' | 'Letter';
export type PaperOrientation = 'portrait' | 'landscape' | 'auto';

export interface TemplatePdfOptions {
  /** Paper format (default: 'A4'). */
  paper?: PaperSize;
  /** Sheet orientation (default: 'auto'). */
  orientation?: PaperOrientation;
  /** Sheet outer margin in mm (default: 10). */
  marginMm?: number;
  /** Overlap between adjacent tiles in mm (default: 10). */
  overlapMm?: number;
  /** Drill diameter in mm (default: loom.pegDiameterMm or 2). */
  drillDiameterMm?: number;
  /** Base peg number for labels (default: 1). */
  pegNumberBase?: number;
}

const PAPER_DIMENSIONS: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  Letter: { w: 215.9, h: 279.4 },
};

/**
 * Generate a 1:1 scale drilling template SVG for woodworking or laser cutting.
 * 1 user unit = 1 mm.
 */
export function toTemplateSVG(loomCfg: LoomConfig, opts: TemplateSvgOptions = {}): string {
  const loom = createLoom(loomCfg);
  const margin = opts.marginMm ?? 25;
  const base = opts.pegNumberBase ?? 1;
  const drillD = opts.drillDiameterMm ?? (loom.pegRadiusMm > 0 ? loom.pegRadiusMm * 2 : 2);
  const drillR = drillD / 2;

  const widthMm = Number((loom.widthMm + 2 * margin).toFixed(3));
  const heightMm = Number((loom.heightMm + 2 * margin).toFixed(3));
  const ox = (loom.extentMm - loom.widthMm) / 2;
  const oy = (loom.extentMm - loom.heightMm) / 2;

  const fx = (v: number): string => (v - ox + margin).toFixed(3);
  const fy = (v: number): string => (v - oy + margin).toFixed(3);

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}">`,
  );
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);

  // Frame outline / center circle
  if (loomCfg.shape === 'circle') {
    out.push(
      `<circle cx="${fx(loom.radiusMm)}" cy="${fy(loom.radiusMm)}" r="${loom.radiusMm}" fill="none" stroke="#ccc" stroke-dasharray="4,4" stroke-width="0.5"/>`,
    );
  } else if (loom.outline) {
    const pts = loom.outline.map((p) => `${fx(p.x)},${fy(p.y)}`).join(' ');
    out.push(`<polygon points="${pts}" fill="none" stroke="#ccc" stroke-dasharray="4,4" stroke-width="0.5"/>`);
  }

  // Center mark (+)
  const cx = fx(loom.extentMm / 2);
  const cy = fy(loom.extentMm / 2);
  const cNumX = Number(cx);
  const cNumY = Number(cy);
  out.push(
    `<line x1="${(cNumX - 5).toFixed(3)}" y1="${cy}" x2="${(cNumX + 5).toFixed(3)}" y2="${cy}" stroke="#999" stroke-width="0.5"/>`,
  );
  out.push(
    `<line x1="${cx}" y1="${(cNumY - 5).toFixed(3)}" x2="${cx}" y2="${(cNumY + 5).toFixed(3)}" stroke="#999" stroke-width="0.5"/>`,
  );
  out.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="none" stroke="#999" stroke-width="0.5"/>`);

  // Pegs: center cross, drill circle, and number label
  out.push('<g id="pegs">');
  for (const p of loom.pegs) {
    const px = fx(p.x);
    const py = fy(p.y);
    const pNumX = Number(px);
    const pNumY = Number(py);

    // Cross hair (3 mm total length)
    out.push(
      `<line x1="${(pNumX - 1.5).toFixed(3)}" y1="${py}" x2="${(pNumX + 1.5).toFixed(3)}" y2="${py}" stroke="#e11d48" stroke-width="0.3"/>`,
    );
    out.push(
      `<line x1="${px}" y1="${(pNumY - 1.5).toFixed(3)}" x2="${px}" y2="${(pNumY + 1.5).toFixed(3)}" stroke="#e11d48" stroke-width="0.3"/>`,
    );

    // Drill circle
    out.push(
      `<circle cx="${px}" cy="${py}" r="${drillR.toFixed(3)}" fill="none" stroke="#111827" stroke-width="0.35"/>`,
    );

    // Number label positioned outwards
    const labelDist = Math.max(drillR + 3.5, 4.5);
    const lx = fx(p.x + p.nx * labelDist);
    const ly = fy(p.y + p.ny * labelDist);
    const isMajor = p.index % 10 === 0;
    const fontW = isMajor ? 'bold' : 'normal';
    const fontS = isMajor ? '3.2' : '2.4';
    const fillCol = isMajor ? '#111827' : '#6b7280';
    out.push(
      `<text x="${lx}" y="${ly}" font-family="sans-serif" font-size="${fontS}" font-weight="${fontW}" fill="${fillCol}" text-anchor="middle" dominant-baseline="central">${p.index + base}</text>`,
    );
  }
  out.push('</g>');

  // 100 mm verification ruler
  const rulerX = margin;
  const rulerY = heightMm - 12;
  out.push('<g id="ruler" font-family="sans-serif" font-size="2.5" fill="#374151">');
  out.push(
    `<line x1="${rulerX}" y1="${rulerY}" x2="${rulerX + 100}" y2="${rulerY}" stroke="#111827" stroke-width="0.5"/>`,
  );
  for (let m = 0; m <= 100; m += 10) {
    const tickH = m % 50 === 0 ? 5 : m % 10 === 0 ? 3.5 : 2;
    out.push(
      `<line x1="${rulerX + m}" y1="${rulerY}" x2="${rulerX + m}" y2="${rulerY - tickH}" stroke="#111827" stroke-width="0.4"/>`,
    );
    if (m === 0 || m === 50 || m === 100) {
      out.push(`<text x="${rulerX + m}" y="${rulerY + 4}" text-anchor="middle">${m} mm</text>`);
    }
  }
  out.push(
    `<text x="${rulerX + 50}" y="${rulerY - 6}" text-anchor="middle" font-weight="bold">Régua de conferência 100 mm (confira com régua física após imprimir)</text>`,
  );
  out.push('</g>');

  // Title block
  const totalPegs = loomPegCount(loomCfg);
  const titleX = widthMm - margin;
  const titleY = heightMm - 14;
  out.push(`<g id="title-block" font-family="sans-serif" font-size="2.6" fill="#374151" text-anchor="end">`);
  out.push(
    `<text x="${titleX}" y="${titleY - 8}" font-weight="bold" font-size="3.2">GABARITO DE FURAÇÃO — WEAVER ART</text>`,
  );
  const shapeDesc =
    loomCfg.shape === 'circle'
      ? `Tear Circular Ø ${loomCfg.diameterMm.toFixed(1)} mm`
      : loomCfg.shape === 'rectangle'
        ? `Tear Retangular ${loomCfg.widthMm.toFixed(1)} × ${loomCfg.heightMm.toFixed(1)} mm`
        : `Tear Personalizado`;
  out.push(
    `<text x="${titleX}" y="${titleY - 4}">${shapeDesc} · ${totalPegs} pinos · Broca Ø ${drillD.toFixed(1)} mm · Escala 1:1</text>`,
  );
  out.push(`<text x="${titleX}" y="${titleY}">Espaçamento mín.: ${loom.minSpacingMm.toFixed(2)} mm</text>`);
  out.push('</g>');

  out.push('</svg>\n');
  return out.join('\n');
}

/**
 * Generate a 1:1 multi-page tiled PDF template for print on standard papers (A4, A3, Letter).
 * Includes an overview cover sheet plus 1:1 tiled sheets with alignment marks and overlap.
 */
export function toTemplatePDF(loomCfg: LoomConfig, opts: TemplatePdfOptions = {}): Uint8Array {
  const loom = createLoom(loomCfg);
  const paper = opts.paper ?? 'A4';
  const marginMm = opts.marginMm ?? 10;
  const overlapMm = opts.overlapMm ?? 10;
  const base = opts.pegNumberBase ?? 1;
  const drillD = opts.drillDiameterMm ?? (loom.pegRadiusMm > 0 ? loom.pegRadiusMm * 2 : 2);
  const drillR = drillD / 2;

  const rawPaper = PAPER_DIMENSIONS[paper];
  let paperW: number;
  let paperH: number;

  const loomW = loom.widthMm;
  const loomH = loom.heightMm;

  // Determine orientation
  if (opts.orientation === 'landscape') {
    paperW = Math.max(rawPaper.w, rawPaper.h);
    paperH = Math.min(rawPaper.w, rawPaper.h);
  } else if (opts.orientation === 'portrait') {
    paperW = Math.min(rawPaper.w, rawPaper.h);
    paperH = Math.max(rawPaper.w, rawPaper.h);
  } else {
    // 'auto': choose orientation with fewer tiles
    const availP_W = Math.min(rawPaper.w, rawPaper.h) - 2 * marginMm;
    const availP_H = Math.max(rawPaper.w, rawPaper.h) - 2 * marginMm;
    const colsP = Math.ceil(Math.max(1, loomW - overlapMm) / Math.max(1, availP_W - overlapMm));
    const rowsP = Math.ceil(Math.max(1, loomH - overlapMm) / Math.max(1, availP_H - overlapMm));
    const tilesP = colsP * rowsP;

    const availL_W = Math.max(rawPaper.w, rawPaper.h) - 2 * marginMm;
    const availL_H = Math.min(rawPaper.w, rawPaper.h) - 2 * marginMm;
    const colsL = Math.ceil(Math.max(1, loomW - overlapMm) / Math.max(1, availL_W - overlapMm));
    const rowsL = Math.ceil(Math.max(1, loomH - overlapMm) / Math.max(1, availL_H - overlapMm));
    const tilesL = colsL * rowsL;

    if (tilesL < tilesP) {
      paperW = Math.max(rawPaper.w, rawPaper.h);
      paperH = Math.min(rawPaper.w, rawPaper.h);
    } else {
      paperW = Math.min(rawPaper.w, rawPaper.h);
      paperH = Math.max(rawPaper.w, rawPaper.h);
    }
  }

  const printW = paperW - 2 * marginMm;
  const printH = paperH - 2 * marginMm;

  // Loom bounding box relative to simulation frame
  const ox = (loom.extentMm - loom.widthMm) / 2;
  const oy = (loom.extentMm - loom.heightMm) / 2;

  // Tiling calculation
  // Each tile covers printW x printH. Step is (printW - overlapMm).
  const stepX = Math.max(1, printW - overlapMm);
  const stepY = Math.max(1, printH - overlapMm);

  const numCols = Math.max(1, Math.ceil(loomW <= printW ? 1 : (loomW - overlapMm) / stepX));
  const numRows = Math.max(1, Math.ceil(loomH <= printH ? 1 : (loomH - overlapMm) / stepY));
  const totalTiles = numCols * numRows;

  const pdf = new PdfDocument();

  // --- PÁGINA 1: CAPA / VISÃO GERAL ---
  const cover = pdf.addPage(paperW, paperH);
  cover.lineWidth(0.3).gray(0.2);

  // Title & Header
  cover.text(marginMm, marginMm + 8, 16, 'WEAVER ART -- GABARITO DE FURACAO', { bold: true });
  cover.text(marginMm, marginMm + 14, 10, 'Instrucoes de Montagem e Especificacoes Tecnicas');

  // Warning
  cover.lineWidth(0.8).gray(0.1, 0.95);
  cover.rect(marginMm, marginMm + 20, printW, 16, 'B');
  cover.gray(0.1);
  cover.text(
    marginMm + 4,
    marginMm + 27,
    9,
    'ATENCAO: Imprima em 100% / Tamanho Real (sem ajustar a pagina / "fit to page").',
    { bold: true },
  );
  cover.text(
    marginMm + 4,
    marginMm + 32,
    8,
    'Sempre confira a regua de 50 mm em cada folha com uma regua fisica antes de furar.',
  );

  // Specs
  const totalPegs = loomPegCount(loomCfg);
  const shapeDesc =
    loomCfg.shape === 'circle'
      ? `Circular (Diametro: ${loomCfg.diameterMm.toFixed(1)} mm)`
      : loomCfg.shape === 'rectangle'
        ? `Retangular (${loomCfg.widthMm.toFixed(1)} x ${loomCfg.heightMm.toFixed(1)} mm)`
        : `Personalizado (${totalPegs} pinos)`;

  cover.text(marginMm, marginMm + 46, 10, 'Especificacoes do Tear:', { bold: true });
  cover.text(marginMm + 4, marginMm + 52, 9, `* Forma: ${shapeDesc}`);
  cover.text(marginMm + 4, marginMm + 58, 9, `* Total de pinos: ${totalPegs}`);
  cover.text(
    marginMm + 4,
    marginMm + 64,
    9,
    `* Diametro dos pinos: ${loom.pegRadiusMm > 0 ? (loom.pegRadiusMm * 2).toFixed(1) : 2} mm`,
  );
  cover.text(marginMm + 4, marginMm + 70, 9, `* Diametro sugerido da broca: ${drillD.toFixed(1)} mm`);
  cover.text(marginMm + 4, marginMm + 76, 9, `* Menor espacamento entre pinos: ${loom.minSpacingMm.toFixed(2)} mm`);
  cover.text(
    marginMm + 4,
    marginMm + 82,
    9,
    `* Folhas de bloco 1:1 necessarias: ${totalTiles} (${numRows} linhas x ${numCols} colunas no formato ${paper})`,
  );

  // Scaled preview of the tiling grid
  const previewBoxY = marginMm + 92;
  const previewBoxH = paperH - previewBoxY - marginMm - 24;
  const previewBoxW = printW;
  const previewScale = Math.min((previewBoxW - 20) / loomW, (previewBoxH - 20) / loomH);

  const prevW = loomW * previewScale;
  const prevH = loomH * previewScale;
  const prevX = marginMm + (previewBoxW - prevW) / 2;
  const prevY = previewBoxY + (previewBoxH - prevH) / 2;

  cover.lineWidth(0.2).gray(0.6);
  cover.rect(prevX, prevY, prevW, prevH, 'S');

  // Preview tiles
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const tx = prevX + c * stepX * previewScale;
      const ty = prevY + r * stepY * previewScale;
      const tw = Math.min(printW, loomW - c * stepX) * previewScale;
      const th = Math.min(printH, loomH - r * stepY) * previewScale;
      cover.lineWidth(0.15).gray(0.5);
      cover.rect(tx, ty, tw, th, 'S');
      cover.gray(0.4);
      cover.text(tx + tw / 2, ty + th / 2 + 1.5, 7, `L${r + 1}.C${c + 1}`, { align: 'center' });
    }
  }

  // Cover 100 mm ruler
  const rulerY = paperH - marginMm - 8;
  cover.lineWidth(0.4).gray(0.1);
  cover
    .moveTo(marginMm, rulerY)
    .lineTo(marginMm + 100, rulerY)
    .stroke();
  for (let m = 0; m <= 100; m += 10) {
    const h = m % 50 === 0 ? 4 : 2.5;
    cover
      .moveTo(marginMm + m, rulerY)
      .lineTo(marginMm + m, rulerY - h)
      .stroke();
    if (m === 0 || m === 50 || m === 100) {
      cover.text(marginMm + m, rulerY + 5, 7, `${m} mm`, { align: 'center' });
    }
  }
  cover.text(marginMm + 50, rulerY - 5, 7, 'Regua de conferencia 100 mm (capa)', { align: 'center', bold: true });

  // --- PÁGINAS DE BLOCO 1:1 ---
  let tileIndex = 0;
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      tileIndex++;
      const page = pdf.addPage(paperW, paperH);

      // Window in loom coordinates (mm) mapped to this page
      const winX0 = c * stepX;
      const winY0 = r * stepY;

      // Coordinate mapping from loom mm (x - ox, y - oy) to sheet mm:
      // sheetX = marginMm + (loomCoordX - winX0)
      // sheetY = marginMm + (loomCoordY - winY0)
      const toSheetX = (xMm: number): number => marginMm + (xMm - ox - winX0);
      const toSheetY = (yMm: number): number => marginMm + (yMm - oy - winY0);

      page.save();
      page.clipRect(marginMm, marginMm, printW, printH);

      // Draw frame outline within window
      if (loomCfg.shape === 'circle') {
        const cx = toSheetX(loom.radiusMm);
        const cy = toSheetY(loom.radiusMm);
        page.lineWidth(0.2).gray(0.7);
        page.circle(cx, cy, loom.radiusMm, 'S');
      } else if (loom.outline) {
        page.lineWidth(0.2).gray(0.7);
        for (let i = 0; i < loom.outline.length; i++) {
          const pA = loom.outline[i];
          const pB = loom.outline[(i + 1) % loom.outline.length];
          page.moveTo(toSheetX(pA.x), toSheetY(pA.y)).lineTo(toSheetX(pB.x), toSheetY(pB.y)).stroke();
        }
      }

      // Draw center mark if inside tile
      const loomCenterX = loom.extentMm / 2;
      const loomCenterY = loom.extentMm / 2;
      const sheetCX = toSheetX(loomCenterX);
      const sheetCY = toSheetY(loomCenterY);
      if (sheetCX >= marginMm && sheetCX <= marginMm + printW && sheetCY >= marginMm && sheetCY <= marginMm + printH) {
        page.lineWidth(0.3).gray(0.5);
        page
          .moveTo(sheetCX - 4, sheetCY)
          .lineTo(sheetCX + 4, sheetCY)
          .stroke();
        page
          .moveTo(sheetCX, sheetCY - 4)
          .lineTo(sheetCX, sheetCY + 4)
          .stroke();
        page.circle(sheetCX, sheetCY, 2, 'S');
        page.text(sheetCX + 3, sheetCY - 3, 6, 'CENTRO');
      }

      // Draw pegs inside or near this tile
      for (const p of loom.pegs) {
        const sx = toSheetX(p.x);
        const sy = toSheetY(p.y);
        // Include with margin to ensure labels on boundary render
        if (sx < marginMm - 10 || sx > marginMm + printW + 10 || sy < marginMm - 10 || sy > marginMm + printH + 10) {
          continue;
        }

        // Center cross
        page.lineWidth(0.25).gray(0.85); // stroke red/dark
        page
          .moveTo(sx - 1.5, sy)
          .lineTo(sx + 1.5, sy)
          .stroke();
        page
          .moveTo(sx, sy - 1.5)
          .lineTo(sx, sy + 1.5)
          .stroke();

        // Drill circle
        page.lineWidth(0.35).gray(0.1);
        page.circle(sx, sy, drillR, 'S');

        // Peg label
        const labelDist = Math.max(drillR + 3.5, 4.5);
        const lx = toSheetX(p.x + p.nx * labelDist);
        const ly = toSheetY(p.y + p.ny * labelDist);
        const isMajor = p.index % 10 === 0;
        page.gray(isMajor ? 0.05 : 0.4);
        page.text(lx, ly + 1, isMajor ? 8 : 6, String(p.index + base), {
          align: 'center',
          bold: isMajor,
        });
      }

      page.restore();

      // Printable area boundary & corner registration marks
      page.lineWidth(0.2).gray(0.4);
      page.rect(marginMm, marginMm, printW, printH, 'S');

      // Registration corner crosses
      const reg = (rx: number, ry: number): void => {
        page.lineWidth(0.3).gray(0.2);
        page
          .moveTo(rx - 3, ry)
          .lineTo(rx + 3, ry)
          .stroke();
        page
          .moveTo(rx, ry - 3)
          .lineTo(rx, ry + 3)
          .stroke();
      };
      reg(marginMm, marginMm);
      reg(marginMm + printW, marginMm);
      reg(marginMm, marginMm + printH);
      reg(marginMm + printW, marginMm + printH);

      // Overlap guide line (dashed)
      if (c > 0) {
        page.lineWidth(0.2).gray(0.6);
        page
          .moveTo(marginMm + overlapMm, marginMm)
          .lineTo(marginMm + overlapMm, marginMm + printH)
          .stroke();
      }
      if (r > 0) {
        page.lineWidth(0.2).gray(0.6);
        page
          .moveTo(marginMm, marginMm + overlapMm)
          .lineTo(marginMm + printW, marginMm + overlapMm)
          .stroke();
      }

      // 50 mm verification ruler at bottom edge of sheet
      const ruleX = marginMm + 6;
      const ruleY = paperH - marginMm + 6;
      page.lineWidth(0.3).gray(0.1);
      page
        .moveTo(ruleX, ruleY)
        .lineTo(ruleX + 50, ruleY)
        .stroke();
      for (let m = 0; m <= 50; m += 10) {
        const h = m % 50 === 0 ? 3.5 : 2;
        page
          .moveTo(ruleX + m, ruleY)
          .lineTo(ruleX + m, ruleY - h)
          .stroke();
        if (m === 0 || m === 50) {
          page.text(ruleX + m, ruleY + 3.5, 5, `${m} mm`, { align: 'center' });
        }
      }
      page.text(ruleX + 25, ruleY - 3, 5, 'Regua 50 mm (100% escala real)', { align: 'center', bold: true });

      // Sheet title and info
      const sheetLabel = `Folha L${r + 1}.C${c + 1} (${tileIndex}/${totalTiles})`;
      page.gray(0.2);
      page.text(marginMm, marginMm - 3, 8, `Weaver Art -- Gabarito 1:1 -- ${sheetLabel}`, { bold: true });
      page.text(marginMm + printW, marginMm - 3, 7, `${shapeDesc} -- Broca O ${drillD.toFixed(1)} mm`, {
        align: 'right',
      });
    }
  }

  return pdf.toBytes();
}
