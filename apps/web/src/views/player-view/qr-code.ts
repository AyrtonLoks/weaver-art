/**
 * Clean, lightweight, zero-dependency QR Code generator in pure TypeScript (ISO/IEC 18004 compliant).
 * Generates crisp vector SVG without any third-party dependencies or external bloat.
 * Tailored for offline knitting resumption links and device synchronization.
 */

// ------------------------------------------------------------- Galois Field GF(256)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d; // x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  return GF_EXP[GF_LOG[x] + GF_LOG[y]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], root);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGeneratorPoly(degree);
  const remainder = new Uint8Array(degree);

  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ remainder[0];
    for (let j = 0; j < degree - 1; j++) {
      remainder[j] = remainder[j + 1] ^ gfMul(gen[j], factor);
    }
    remainder[degree - 1] = gfMul(gen[degree - 1], factor);
  }

  return remainder;
}

// ---------------------------------------------------- Version Capacity & Alignment
interface VersionSpec {
  version: number;
  totalCodewords: number;
  ecCodewordsPerBlock: number;
  numBlocksGroup1: number;
  dataCodewordsBlock1: number;
  numBlocksGroup2: number;
  dataCodewordsBlock2: number;
  alignmentPositions: number[];
}

/** Table for Error Correction Level M (Medium ~15% recovery, ideal for phone screens) */
const QR_SPECS_LEVEL_M: VersionSpec[] = [
  {
    version: 1,
    totalCodewords: 26,
    ecCodewordsPerBlock: 10,
    numBlocksGroup1: 1,
    dataCodewordsBlock1: 16,
    numBlocksGroup2: 0,
    dataCodewordsBlock2: 0,
    alignmentPositions: [],
  },
  {
    version: 2,
    totalCodewords: 44,
    ecCodewordsPerBlock: 16,
    numBlocksGroup1: 1,
    dataCodewordsBlock1: 28,
    numBlocksGroup2: 0,
    dataCodewordsBlock2: 0,
    alignmentPositions: [6, 18],
  },
  {
    version: 3,
    totalCodewords: 70,
    ecCodewordsPerBlock: 26,
    numBlocksGroup1: 1,
    dataCodewordsBlock1: 44,
    numBlocksGroup2: 0,
    dataCodewordsBlock2: 0,
    alignmentPositions: [6, 22],
  },
  {
    version: 4,
    totalCodewords: 100,
    ecCodewordsPerBlock: 18,
    numBlocksGroup1: 2,
    dataCodewordsBlock1: 32,
    numBlocksGroup2: 0,
    dataCodewordsBlock2: 0,
    alignmentPositions: [6, 26],
  },
  {
    version: 5,
    totalCodewords: 134,
    ecCodewordsPerBlock: 24,
    numBlocksGroup1: 2,
    dataCodewordsBlock1: 43,
    numBlocksGroup2: 0,
    dataCodewordsBlock2: 0,
    alignmentPositions: [6, 30],
  },
  {
    version: 6,
    totalCodewords: 172,
    ecCodewordsPerBlock: 16,
    numBlocksGroup1: 4,
    dataCodewordsBlock1: 27,
    numBlocksGroup2: 0,
    dataCodewordsBlock2: 0,
    alignmentPositions: [6, 34],
  },
  {
    version: 7,
    totalCodewords: 196,
    ecCodewordsPerBlock: 18,
    numBlocksGroup1: 2,
    dataCodewordsBlock1: 31,
    numBlocksGroup2: 4,
    dataCodewordsBlock2: 32,
    alignmentPositions: [6, 22, 38],
  },
  {
    version: 8,
    totalCodewords: 242,
    ecCodewordsPerBlock: 22,
    numBlocksGroup1: 4,
    dataCodewordsBlock1: 38,
    numBlocksGroup2: 2,
    dataCodewordsBlock2: 39,
    alignmentPositions: [6, 24, 42],
  },
  {
    version: 9,
    totalCodewords: 292,
    ecCodewordsPerBlock: 22,
    numBlocksGroup1: 3,
    dataCodewordsBlock1: 36,
    numBlocksGroup2: 5,
    dataCodewordsBlock2: 37,
    alignmentPositions: [6, 26, 46],
  },
  {
    version: 10,
    totalCodewords: 346,
    ecCodewordsPerBlock: 26,
    numBlocksGroup1: 5,
    dataCodewordsBlock1: 43,
    numBlocksGroup2: 3,
    dataCodewordsBlock2: 44,
    alignmentPositions: [6, 28, 50],
  },
];

// ------------------------------------------------------------- BitStream Helper
class BitStream {
  private bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  toUint8Array(): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      bytes[i >>> 3] |= this.bits[i] << (7 - (i & 7));
    }
    return bytes;
  }
}

// ---------------------------------------------------------------- Core QR Engine
export class QRCodeGenerator {
  /**
   * Generates a matrix of booleans (true = dark, false = light) for the given UTF-8 text string.
   */
  static generateMatrix(text: string): boolean[][] {
    const textBytes = new TextEncoder().encode(text);

    // Pick smallest version fitting text in Level M
    let spec: VersionSpec | null = null;
    for (const candidate of QR_SPECS_LEVEL_M) {
      const totalDataCodewords =
        candidate.numBlocksGroup1 * candidate.dataCodewordsBlock1 +
        candidate.numBlocksGroup2 * candidate.dataCodewordsBlock2;
      // Byte mode overhead: 4 bits mode indicator + 8 or 16 bits count indicator
      const charCountBits = candidate.version < 10 ? 8 : 16;
      const neededBytes = Math.ceil((4 + charCountBits + textBytes.length * 8 + 4) / 8);
      if (neededBytes <= totalDataCodewords) {
        spec = candidate;
        break;
      }
    }

    if (!spec) {
      throw new Error(`Texto muito longo para QR Code móvel (${textBytes.length} bytes).`);
    }

    const totalDataCodewords =
      spec.numBlocksGroup1 * spec.dataCodewordsBlock1 + spec.numBlocksGroup2 * spec.dataCodewordsBlock2;

    // 1. Encode bit stream (Byte Mode: 0100)
    const stream = new BitStream();
    stream.push(0b0100, 4); // Byte mode
    const countBits = spec.version < 10 ? 8 : 16;
    stream.push(textBytes.length, countBits);
    for (const b of textBytes) {
      stream.push(b, 8);
    }

    // Terminator (up to 4 bits)
    const terminatorBits = Math.min(4, totalDataCodewords * 8 - stream.length);
    stream.push(0, terminatorBits);

    // Byte boundary padding
    if (stream.length % 8 !== 0) {
      stream.push(0, 8 - (stream.length % 8));
    }

    // Pad bytes 0xEC and 0x11
    const dataBytes = stream.toUint8Array();
    const padded = new Uint8Array(totalDataCodewords);
    padded.set(dataBytes);
    let padToggle = 0xec;
    for (let i = dataBytes.length; i < totalDataCodewords; i++) {
      padded[i] = padToggle;
      padToggle = padToggle === 0xec ? 0x11 : 0xec;
    }

    // 2. Compute Reed-Solomon per block & Interleave
    const totalBlocks = spec.numBlocksGroup1 + spec.numBlocksGroup2;
    const blocksData: Uint8Array[] = [];
    const blocksEc: Uint8Array[] = [];
    let offset = 0;

    for (let b = 0; b < spec.numBlocksGroup1; b++) {
      const slice = padded.slice(offset, offset + spec.dataCodewordsBlock1);
      blocksData.push(slice);
      blocksEc.push(rsComputeRemainder(slice, spec.ecCodewordsPerBlock));
      offset += spec.dataCodewordsBlock1;
    }
    for (let b = 0; b < spec.numBlocksGroup2; b++) {
      const slice = padded.slice(offset, offset + spec.dataCodewordsBlock2);
      blocksData.push(slice);
      blocksEc.push(rsComputeRemainder(slice, spec.ecCodewordsPerBlock));
      offset += spec.dataCodewordsBlock2;
    }

    // Interleave data codewords
    const finalCodewords = new Uint8Array(spec.totalCodewords);
    let outIdx = 0;
    const maxDataLen = Math.max(spec.dataCodewordsBlock1, spec.dataCodewordsBlock2);
    for (let i = 0; i < maxDataLen; i++) {
      for (let b = 0; b < totalBlocks; b++) {
        if (i < blocksData[b].length) {
          finalCodewords[outIdx++] = blocksData[b][i];
        }
      }
    }

    // Interleave EC codewords
    for (let i = 0; i < spec.ecCodewordsPerBlock; i++) {
      for (let b = 0; b < totalBlocks; b++) {
        finalCodewords[outIdx++] = blocksEc[b][i];
      }
    }

    // 3. Grid Construction
    const size = spec.version * 4 + 17;
    const grid: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));
    const reserved: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

    function setModule(r: number, c: number, val: boolean): void {
      grid[r][c] = val;
      reserved[r][c] = true;
    }

    // Finder Patterns (7x7) + Separators
    const placeFinder = (r: number, c: number): void => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const row = r + dr;
          const col = c + dc;
          if (row < 0 || row >= size || col < 0 || col >= size) continue;
          if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
            const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
            const isCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
            setModule(row, col, isBorder || isCenter);
          } else {
            setModule(row, col, false); // separator
          }
        }
      }
    };

    placeFinder(0, 0);
    placeFinder(0, size - 7);
    placeFinder(size - 7, 0);

    // Timing Patterns
    for (let i = 8; i < size - 8; i++) {
      if (!reserved[6][i]) setModule(6, i, i % 2 === 0);
      if (!reserved[i][6]) setModule(i, 6, i % 2 === 0);
    }

    // Alignment Patterns
    const alignCoords = spec.alignmentPositions;
    for (const r of alignCoords) {
      for (const c of alignCoords) {
        if (reserved[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isBorder = Math.abs(dr) === 2 || Math.abs(dc) === 2;
            const isCenter = dr === 0 && dc === 0;
            setModule(r + dr, c + dc, isBorder || isCenter);
          }
        }
      }
    }

    // Dark Module
    setModule(4 * spec.version + 9, 8, true);

    // Reserve Format Information areas
    for (let i = 0; i <= 8; i++) {
      reserved[8][i] = true;
      reserved[i][8] = true;
      reserved[8][size - 1 - i] = true;
      reserved[size - 1 - i][8] = true;
    }

    // 4. Place Data Codewords (Zig-Zag)
    let bitIdx = 0;
    const finalBits: number[] = [];
    for (const byte of finalCodewords) {
      for (let i = 7; i >= 0; i--) {
        finalBits.push((byte >>> i) & 1);
      }
    }

    let up = true;
    for (let c = size - 1; c > 0; c -= 2) {
      if (c === 6) c--; // Skip vertical timing column
      for (let rStep = 0; rStep < size; rStep++) {
        const r = up ? size - 1 - rStep : rStep;
        for (let dc = 0; dc < 2; dc++) {
          const col = c - dc;
          if (!reserved[r][col]) {
            const bit = bitIdx < finalBits.length ? finalBits[bitIdx++] === 1 : false;
            grid[r][col] = bit;
          }
        }
      }
      up = !up;
    }

    // 5. Apply Optimal Mask (Mask 0: (row + col) % 2 === 0)
    // Standard Level M format bits for Mask 0: 0b101010000010010
    // Format = Level M (00) + Mask 0 (000) = 00000 -> BCH code: 0000010010 -> XOR 101010000010010 = 101010000010010
    const formatBits = 0b101010000010010;

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c]) {
          const invert = (r + c) % 2 === 0;
          if (invert) {
            grid[r][c] = !grid[r][c];
          }
        }
      }
    }

    // 6. Write Format Bits around finders
    for (let i = 0; i < 15; i++) {
      const bit = ((formatBits >>> (14 - i)) & 1) === 1;

      // Around top-left
      if (i <= 5) setModule(8, i, bit);
      else if (i === 6) setModule(8, 7, bit);
      else if (i === 7) setModule(8, 8, bit);
      else if (i === 8) setModule(7, 8, bit);
      else setModule(14 - i, 8, bit);

      // Around top-right & bottom-left
      if (i < 8) setModule(8, size - 1 - i, bit);
      else setModule(size - 15 + i, 8, bit);
    }

    return grid.map((row) => row.map((m) => m === true));
  }

  /**
   * Generates a clean, scalable SVG element string of the QR Code.
   */
  static toSVG(text: string, options: { margin?: number; fill?: string; background?: string } = {}): string {
    const matrix = this.generateMatrix(text);
    const size = matrix.length;
    const margin = options.margin ?? 4;
    const totalSize = size + margin * 2;
    const fill = options.fill ?? '#121210';
    const bg = options.background ?? '#ffffff';

    let path = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c]) {
          path += `M${c + margin},${r + margin}h1v1h-1z `;
        }
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges" width="100%" height="100%">
  <rect width="100%" height="100%" fill="${bg}" />
  <path d="${path.trim()}" fill="${fill}" />
</svg>`;
  }
}
