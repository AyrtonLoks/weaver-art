import { describe, expect, it } from 'vitest';
import { toTemplatePDF, toTemplateSVG, VRELLIS_LOOM, type RectangleLoomConfig } from '../src/index.js';

describe('Drilling template export (SVG and PDF 1:1)', () => {
  it('generates a valid 1:1 template SVG with drill holes, center marks and 100 mm ruler', () => {
    const rectCfg: RectangleLoomConfig = {
      shape: 'rectangle',
      widthMm: 400,
      heightMm: 300,
      pegsX: 10,
      pegsY: 8,
      pegDiameterMm: 2,
    };
    const svg = toTemplateSVG(rectCfg, { marginMm: 20, drillDiameterMm: 2 });
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="440mm"');
    expect(svg).toContain('height="340mm"');
    expect(svg).toContain('Régua de conferência 100 mm');
    expect(svg).toContain('GABARITO DE FURAÇÃO');

    // Expected 2*(10+8)-4 = 32 pegs -> 32 drill circles
    const drillMatches = svg.match(/<circle cx="[^"]+" cy="[^"]+" r="1.000"/g);
    expect(drillMatches).not.toBeNull();
    expect(drillMatches!.length).toBe(32);
  });

  it('generates a valid PDF 1.4 where every xref offset points directly to obj header', () => {
    const rectCfg: RectangleLoomConfig = {
      shape: 'rectangle',
      widthMm: 250,
      heightMm: 200,
      pegsX: 6,
      pegsY: 5,
      pegDiameterMm: 2,
    };
    const pdfBytes = toTemplatePDF(rectCfg, { paper: 'A4', orientation: 'auto' });
    const pdfText = new TextDecoder('latin1').decode(pdfBytes);

    expect(pdfText.startsWith('%PDF-1.4')).toBe(true);
    expect(pdfText.trimEnd().endsWith('%%EOF')).toBe(true);

    // Locate startxref
    const startXrefMatch = pdfText.match(/startxref\r?\n(\d+)\r?\n%%EOF/);
    expect(startXrefMatch).not.toBeNull();
    const xrefOffset = parseInt(startXrefMatch![1], 10);

    // Read xref table
    const xrefSection = pdfText.slice(xrefOffset);
    expect(xrefSection.startsWith('xref')).toBe(true);

    const xrefLines = xrefSection.split(/\r?\n/);
    const sizeLine = xrefLines[1];
    const [, countStr] = sizeLine.split(' ');
    const totalObjs = parseInt(countStr, 10) - 1;

    for (let objNum = 1; objNum <= totalObjs; objNum++) {
      // Line 0 is 'xref', line 1 is '0 N', line 2 is obj 0 ('... 65535 f')
      const entryLine = xrefLines[2 + objNum];
      const offset = parseInt(entryLine.slice(0, 10), 10);
      expect(Number.isFinite(offset)).toBe(true);

      const targetSlice = pdfText.slice(offset, offset + 20);
      expect(targetSlice).toMatch(new RegExp(`^${objNum} 0 obj`));
    }
  });

  it('tiles large looms across multiple pages on A4 paper', () => {
    // VRELLIS_LOOM is 711.2 mm diameter, which cannot fit on single A4 sheet (210x297 mm)
    const pdfBytes = toTemplatePDF(VRELLIS_LOOM, { paper: 'A4' });
    const pdfText = new TextDecoder('latin1').decode(pdfBytes);

    // Number of pages should be > 1 (1 cover page + multiple 1:1 tile blocks)
    const pageMatches = pdfText.match(/\/Type \/Page\b/g);
    expect(pageMatches).not.toBeNull();
    expect(pageMatches!.length).toBeGreaterThan(4);
    expect(pdfText).toContain('Weaver Art -- Gabarito 1:1');
    expect(pdfText).toContain('Regua 50 mm \\(100% escala real\\)');
  });
});
