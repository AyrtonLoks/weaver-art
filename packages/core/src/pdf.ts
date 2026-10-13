/**
 * Minimal, zero-dependency PDF 1.4 generator in pure TypeScript.
 * Produces valid PDF documents with exact byte-offset xref tables.
 */

export interface PdfPage {
  lineWidth(mm: number): this;
  gray(stroke: number, fill?: number): this;
  moveTo(x: number, y: number): this;
  lineTo(x: number, y: number): this;
  stroke(): this;
  circle(cx: number, cy: number, r: number, mode?: 'S' | 'f' | 'B'): this;
  rect(x: number, y: number, w: number, h: number, mode?: 'S' | 'f' | 'B'): this;
  clipRect(x: number, y: number, w: number, h: number): this;
  save(): this;
  restore(): this;
  text(
    x: number,
    y: number,
    sizePt: number,
    s: string,
    opts?: { align?: 'left' | 'center' | 'right'; bold?: boolean },
  ): this;
}

class PdfPageImpl implements PdfPage {
  readonly widthPt: number;
  readonly heightPt: number;
  private ops: string[] = [];

  constructor(
    readonly widthMm: number,
    readonly heightMm: number,
  ) {
    this.widthPt = (widthMm * 72) / 25.4;
    this.heightPt = (heightMm * 72) / 25.4;
  }

  private toPtX(xMm: number): number {
    return (xMm * 72) / 25.4;
  }

  private toPtY(yMm: number): number {
    return this.heightPt - (yMm * 72) / 25.4;
  }

  private fmt(n: number): string {
    return Number(n.toFixed(3)).toString();
  }

  lineWidth(mm: number): this {
    const pt = (mm * 72) / 25.4;
    this.ops.push(`${this.fmt(pt)} w`);
    return this;
  }

  gray(stroke: number, fill?: number): this {
    this.ops.push(`${this.fmt(stroke)} G`);
    if (fill !== undefined) {
      this.ops.push(`${this.fmt(fill)} g`);
    }
    return this;
  }

  moveTo(x: number, y: number): this {
    this.ops.push(`${this.fmt(this.toPtX(x))} ${this.fmt(this.toPtY(y))} m`);
    return this;
  }

  lineTo(x: number, y: number): this {
    this.ops.push(`${this.fmt(this.toPtX(x))} ${this.fmt(this.toPtY(y))} l`);
    return this;
  }

  stroke(): this {
    this.ops.push('S');
    return this;
  }

  rect(x: number, y: number, w: number, h: number, mode: 'S' | 'f' | 'B' = 'S'): this {
    const ptX = this.toPtX(x);
    const ptY = this.toPtY(y + h); // Lower-left in PDF coordinates
    const ptW = (w * 72) / 25.4;
    const ptH = (h * 72) / 25.4;
    this.ops.push(`${this.fmt(ptX)} ${this.fmt(ptY)} ${this.fmt(ptW)} ${this.fmt(ptH)} re`);
    this.ops.push(mode);
    return this;
  }

  clipRect(x: number, y: number, w: number, h: number): this {
    const ptX = this.toPtX(x);
    const ptY = this.toPtY(y + h);
    const ptW = (w * 72) / 25.4;
    const ptH = (h * 72) / 25.4;
    this.ops.push(`${this.fmt(ptX)} ${this.fmt(ptY)} ${this.fmt(ptW)} ${this.fmt(ptH)} re W n`);
    return this;
  }

  save(): this {
    this.ops.push('q');
    return this;
  }

  restore(): this {
    this.ops.push('Q');
    return this;
  }

  circle(cx: number, cy: number, r: number, mode: 'S' | 'f' | 'B' = 'S'): this {
    const k = 0.5522847498;
    const d = r * k;

    // 4 cubic Béziers approximating a circle in user space (mm, Y down)
    const p0 = { x: this.toPtX(cx + r), y: this.toPtY(cy) };
    const c1a = { x: this.toPtX(cx + r), y: this.toPtY(cy + d) };
    const c1b = { x: this.toPtX(cx + d), y: this.toPtY(cy + r) };
    const p1 = { x: this.toPtX(cx), y: this.toPtY(cy + r) };

    const c2a = { x: this.toPtX(cx - d), y: this.toPtY(cy + r) };
    const c2b = { x: this.toPtX(cx - r), y: this.toPtY(cy + d) };
    const p2 = { x: this.toPtX(cx - r), y: this.toPtY(cy) };

    const c3a = { x: this.toPtX(cx - r), y: this.toPtY(cy - d) };
    const c3b = { x: this.toPtX(cx - d), y: this.toPtY(cy - r) };
    const p3 = { x: this.toPtX(cx), y: this.toPtY(cy - r) };

    const c4a = { x: this.toPtX(cx + d), y: this.toPtY(cy - r) };
    const c4b = { x: this.toPtX(cx + r), y: this.toPtY(cy - d) };

    this.ops.push(`${this.fmt(p0.x)} ${this.fmt(p0.y)} m`);
    this.ops.push(
      `${this.fmt(c1a.x)} ${this.fmt(c1a.y)} ${this.fmt(c1b.x)} ${this.fmt(c1b.y)} ${this.fmt(p1.x)} ${this.fmt(p1.y)} c`,
    );
    this.ops.push(
      `${this.fmt(c2a.x)} ${this.fmt(c2a.y)} ${this.fmt(c2b.x)} ${this.fmt(c2b.y)} ${this.fmt(p2.x)} ${this.fmt(p2.y)} c`,
    );
    this.ops.push(
      `${this.fmt(c3a.x)} ${this.fmt(c3a.y)} ${this.fmt(c3b.x)} ${this.fmt(c3b.y)} ${this.fmt(p3.x)} ${this.fmt(p3.y)} c`,
    );
    this.ops.push(
      `${this.fmt(c4a.x)} ${this.fmt(c4a.y)} ${this.fmt(c4b.x)} ${this.fmt(c4b.y)} ${this.fmt(p0.x)} ${this.fmt(p0.y)} c`,
    );
    this.ops.push(`h`);
    this.ops.push(mode);
    return this;
  }

  text(
    x: number,
    y: number,
    sizePt: number,
    s: string,
    opts: { align?: 'left' | 'center' | 'right'; bold?: boolean } = {},
  ): this {
    const bold = Boolean(opts.bold);
    const fontName = bold ? '/F2' : '/F1';
    let ptX = this.toPtX(x);
    const ptY = this.toPtY(y); // baseline

    const align = opts.align ?? 'left';
    if (align !== 'left') {
      const width = estimateTextWidth(s, sizePt, bold);
      if (align === 'center') ptX -= width / 2;
      else if (align === 'right') ptX -= width;
    }

    const encoded = encodeWinAnsi(s);
    this.ops.push(`BT`);
    this.ops.push(`${fontName} ${this.fmt(sizePt)} Tf`);
    this.ops.push(`${this.fmt(ptX)} ${this.fmt(ptY)} Td`);
    this.ops.push(`(${encoded}) Tj`);
    this.ops.push(`ET`);
    return this;
  }

  getStreamContent(): string {
    return this.ops.join('\n') + '\n';
  }
}

export class PdfDocument {
  private pages: PdfPageImpl[] = [];

  addPage(widthMm: number, heightMm: number): PdfPage {
    const page = new PdfPageImpl(widthMm, heightMm);
    this.pages.push(page);
    return page;
  }

  toBytes(): Uint8Array {
    const parts: string[] = [];
    const offsets: number[] = [];
    let currentOffset = 0;

    const pushStr = (str: string): void => {
      parts.push(str);
      currentOffset += str.length;
    };

    const recordObject = (num: number, content: string): void => {
      offsets[num] = currentOffset;
      pushStr(`${num} 0 obj\n${content}\nendobj\n`);
    };

    // Header
    pushStr('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');

    // Obj 1: Catalog
    recordObject(1, '<< /Type /Catalog /Pages 2 0 R >>');

    const numPages = this.pages.length;
    const pageObjNums: number[] = [];
    for (let i = 0; i < numPages; i++) {
      pageObjNums.push(5 + 2 * i);
    }

    // Obj 2: Pages
    const kidsStr = pageObjNums.map((n) => `${n} 0 R`).join(' ');
    recordObject(2, `<< /Type /Pages /Kids [ ${kidsStr} ] /Count ${numPages} >>`);

    // Obj 3: Helvetica
    recordObject(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

    // Obj 4: Helvetica-Bold
    recordObject(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    // Pages and Content streams
    for (let i = 0; i < numPages; i++) {
      const page = this.pages[i];
      const pageNum = 5 + 2 * i;
      const contentNum = 6 + 2 * i;
      const streamContent = page.getStreamContent();
      const streamBytesLen = streamContent.length;

      // Page obj
      const pageDef =
        `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [ 0 0 ${page.widthPt.toFixed(3)} ${page.heightPt.toFixed(3)} ] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> ` +
        `/Contents ${contentNum} 0 R >>`;
      recordObject(pageNum, pageDef);

      // Content stream obj
      const streamDef = `<< /Length ${streamBytesLen} >>\nstream\n${streamContent}endstream`;
      recordObject(contentNum, streamDef);
    }

    const totalObjs = 4 + 2 * numPages;
    const startXref = currentOffset;

    // XREF table (each row must be exactly 20 bytes including CRLF: 10 + ' ' + 5 + ' ' + char + '\r\n')
    pushStr('xref\n');
    pushStr(`0 ${totalObjs + 1}\n`);
    pushStr('0000000000 65535 f \r\n');
    for (let i = 1; i <= totalObjs; i++) {
      const offStr = String(offsets[i]).padStart(10, '0');
      pushStr(`${offStr} 00000 n \r\n`);
    }

    // Trailer
    pushStr(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\n`);
    pushStr(`startxref\n${startXref}\n%%EOF\n`);

    const totalStr = parts.join('');
    const buf = new Uint8Array(totalStr.length);
    for (let i = 0; i < totalStr.length; i++) {
      buf[i] = totalStr.charCodeAt(i) & 0xff;
    }
    return buf;
  }
}

function estimateTextWidth(s: string, sizePt: number, bold: boolean): number {
  let totalUnits = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      totalUnits += 556;
    } else if (code === 32 || code === 44 || code === 46 || code === 58 || code === 59) {
      totalUnits += 278;
    } else if (code === 45) {
      totalUnits += 333;
    } else if (code >= 65 && code <= 90) {
      totalUnits += bold ? 720 : 667;
    } else if (code >= 97 && code <= 122) {
      totalUnits += bold ? 556 : 500;
    } else {
      totalUnits += 500;
    }
  }
  return (totalUnits / 1000) * sizePt;
}

function encodeWinAnsi(s: string): string {
  // Map common Unicode characters to WinAnsi equivalents
  const normalized = s.replace(/→/g, '->').replace(/←/g, '<-').replace(/—/g, '--').replace(/–/g, '-');

  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const code = ch.charCodeAt(0);
    if (ch === '(') out += '\\(';
    else if (ch === ')') out += '\\)';
    else if (ch === '\\') out += '\\\\';
    else if (code >= 32 && code <= 126) {
      out += ch;
    } else if (code <= 255) {
      // Octal escape for 8-bit Latin1 / WinAnsi characters
      const octal = code.toString(8).padStart(3, '0');
      out += `\\${octal}`;
    } else {
      out += '?';
    }
  }
  return out;
}
