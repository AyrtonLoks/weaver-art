import { describe, expect, it } from 'vitest';
import { createLoom, parsePegsCSV, toPegsCSV, type RectangleLoomConfig } from '../src/index.js';

describe('pegs-csv parser and serializer', () => {
  it('parses standard comma-separated CSV with header', () => {
    const csv = `index,x_mm,y_mm
0,10.5,20.0
1,30.2,40.1
2,50.0,60.0`;

    const pegs = parsePegsCSV(csv);
    expect(pegs.length).toBe(3);
    expect(pegs[0]).toEqual({ x: 10.5, y: 20.0 });
    expect(pegs[1]).toEqual({ x: 30.2, y: 40.1 });
    expect(pegs[2]).toEqual({ x: 50.0, y: 60.0 });
  });

  it('parses semicolon-separated CSV with decimal commas and comments', () => {
    const csv = `# Configuração de pinos para tear artesanal
# Formato europeu: ponto-e-vírgula e vírgula decimal
x;y
10,5;20,0
30,2;40,1
50,0;60,0`;

    const pegs = parsePegsCSV(csv);
    expect(pegs.length).toBe(3);
    expect(pegs[0]).toEqual({ x: 10.5, y: 20.0 });
    expect(pegs[1]).toEqual({ x: 30.2, y: 40.1 });
    expect(pegs[2]).toEqual({ x: 50.0, y: 60.0 });
  });

  it('parses tab-separated TSV without header', () => {
    const tsv = `10.5\t20.0\n30.2\t40.1\n50.0\t60.0`;
    const pegs = parsePegsCSV(tsv);
    expect(pegs.length).toBe(3);
    expect(pegs[0]).toEqual({ x: 10.5, y: 20.0 });
  });

  it('reports descriptive errors with 1-based line numbers on invalid rows', () => {
    const badCsv = `index,x,y
0,10.0,20.0
1,invalido,40.0
2,50.0,60.0`;

    expect(() => parsePegsCSV(badCsv)).toThrow(/Linha 3/);
  });

  it('fails if fewer than 3 pegs are provided', () => {
    const twoPegs = `0,10,20\n1,30,40`;
    expect(() => parsePegsCSV(twoPegs)).toThrow(/Pinos insuficientes/);
  });

  it('performs clean round-trip with toPegsCSV', () => {
    const rectCfg: RectangleLoomConfig = {
      shape: 'rectangle',
      widthMm: 200,
      heightMm: 150,
      pegsX: 3,
      pegsY: 3,
      pegDiameterMm: 2,
    };
    const loom = createLoom(rectCfg);
    const csv = toPegsCSV(loom, { origin: 'top-left' });
    const parsed = parsePegsCSV(csv);

    expect(parsed.length).toBe(loom.pegs.length);
    // Relative dimensions match exactly
    const loomFromCsv = createLoom({ shape: 'custom', pegs: parsed, pegDiameterMm: 2 });
    expect(loomFromCsv.widthMm).toBeCloseTo(loom.widthMm, 2);
    expect(loomFromCsv.heightMm).toBeCloseTo(loom.heightMm, 2);
    expect(loomFromCsv.extentMm).toBeCloseTo(loom.extentMm, 2);

    for (let i = 0; i < parsed.length; i++) {
      expect(loomFromCsv.pegs[i].x).toBeCloseTo(loom.pegs[i].x, 2);
      expect(loomFromCsv.pegs[i].y).toBeCloseTo(loom.pegs[i].y, 2);
    }
  });

  it('supports // comment lines and trailing delimiters cleanly', () => {
    const csv = `// Pinos exportados do Rhino / CAD
// Comentario em barra dupla
x, y,
10.5, 20.0,
30.2, 40.1,
50.0, 60.0,
`;
    const pegs = parsePegsCSV(csv);
    expect(pegs.length).toBe(3);
    expect(pegs[0]).toEqual({ x: 10.5, y: 20.0 });
    expect(pegs[1]).toEqual({ x: 30.2, y: 40.1 });
    expect(pegs[2]).toEqual({ x: 50.0, y: 60.0 });
  });
});
