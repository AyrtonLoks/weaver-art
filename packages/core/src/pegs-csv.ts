import { createLoom, type Loom } from './geometry.js';
import type { LoomConfig } from './types.js';

export interface ToPegsCsvOptions {
  /** Coordinate origin. 'top-left' aligns to bounding box corner; 'center' aligns to center (0,0). */
  origin?: 'top-left' | 'center';
}

/**
 * Parse peg coordinates from a CSV/TSV formatted string.
 *
 * Supports:
 * - Comma, semicolon, or tab separators.
 * - Semicolon with decimal commas (e.g. `12,5;34,2`).
 * - Optional header row (e.g. `index,x_mm,y_mm` or `x,y`).
 * - Comment lines starting with `#`.
 * - Throws descriptive errors with 1-based line numbers.
 */
export function parsePegsCSV(text: string): { x: number; y: number }[] {
  const lines = text.split(/\r?\n/);
  const rows: { lineNum: number; content: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0 || raw.startsWith('#') || raw.startsWith('//')) continue;
    rows.push({ lineNum: i + 1, content: raw });
  }

  if (rows.length === 0) {
    throw new Error('Arquivo CSV vazio ou sem dados de pinos');
  }

  // Detect separator from the first data row
  const firstLine = rows[0].content;
  let sep = ',';
  if (firstLine.includes('\t')) {
    sep = '\t';
  } else if (firstLine.includes(';') && !firstLine.includes(',')) {
    sep = ';';
  } else if (firstLine.includes(';')) {
    // Semicolon takes precedence if used as field separator with decimal comma
    sep = ';';
  }

  let startIdx = 0;
  let xCol = -1;
  let yCol = -1;

  // Check if first row is a header
  const firstTokens = firstLine.split(sep).map((t) => t.trim().toLowerCase());
  while (firstTokens.length > 2 && firstTokens[firstTokens.length - 1] === '') {
    firstTokens.pop();
  }
  const hasAlpha = firstTokens.some((t) => /[a-z]/i.test(t));
  if (hasAlpha) {
    startIdx = 1;
    for (let c = 0; c < firstTokens.length; c++) {
      const col = firstTokens[c];
      if (col === 'x' || col === 'x_mm' || col.startsWith('x(') || col.startsWith('x_')) {
        xCol = c;
      } else if (col === 'y' || col === 'y_mm' || col.startsWith('y(') || col.startsWith('y_')) {
        yCol = c;
      }
    }
  }

  const pegs: { x: number; y: number }[] = [];
  for (let r = startIdx; r < rows.length; r++) {
    const { lineNum, content } = rows[r];
    const tokens = content.split(sep).map((t) => t.trim());
    while (tokens.length > 2 && tokens[tokens.length - 1] === '') {
      tokens.pop();
    }
    if (tokens.length < 2) {
      throw new Error(`Linha ${lineNum}: esperadas ao menos 2 colunas de coordenadas, encontrado "${content}"`);
    }

    let rawX: string;
    let rawY: string;

    if (xCol >= 0 && yCol >= 0 && xCol < tokens.length && yCol < tokens.length) {
      rawX = tokens[xCol];
      rawY = tokens[yCol];
    } else if (tokens.length === 2) {
      rawX = tokens[0];
      rawY = tokens[1];
    } else {
      // 3 or more columns without recognized header: assume index is col 0, x is col 1, y is col 2
      rawX = tokens[1];
      rawY = tokens[2];
    }

    // Support decimal comma if semicolon separator
    if (sep === ';') {
      rawX = rawX.replace(',', '.');
      rawY = rawY.replace(',', '.');
    }

    const x = parseFloat(rawX);
    const y = parseFloat(rawY);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Linha ${lineNum}: coordenadas numéricas inválidas (x="${rawX}", y="${rawY}")`);
    }

    pegs.push({ x, y });
  }

  if (pegs.length < 3) {
    throw new Error(`Pinos insuficientes: encontrados ${pegs.length}, mínimo necessário é 3`);
  }

  return pegs;
}

/**
 * Serialize a loom's peg positions into CSV format.
 * Format:
 * ```csv
 * index,x_mm,y_mm
 * 0,0.000,0.000
 * ...
 * ```
 */
export function toPegsCSV(loomInput: Loom | LoomConfig, options: ToPegsCsvOptions = {}): string {
  const loom =
    'pegs' in loomInput && Array.isArray(loomInput.pegs) && 'extentMm' in loomInput
      ? (loomInput as Loom)
      : createLoom(loomInput as LoomConfig);

  const origin = options.origin ?? 'top-left';

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of loom.pegs) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const ox = origin === 'center' ? (minX + maxX) / 2 : minX;
  const oy = origin === 'center' ? (minY + maxY) / 2 : minY;

  const lines = ['index,x_mm,y_mm'];
  for (let i = 0; i < loom.pegs.length; i++) {
    const p = loom.pegs[i];
    const x = (p.x - ox).toFixed(3);
    const y = (p.y - oy).toFixed(3);
    lines.push(`${i},${x},${y}`);
  }

  return lines.join('\n') + '\n';
}
