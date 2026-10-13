import { describe, expect, it } from 'vitest';
import { applyClahe } from '../src/clahe.js';

describe('applyClahe', () => {
  it('preserves values within [0, 1] range', () => {
    const size = 64;
    const input = new Float32Array(size * size);
    for (let i = 0; i < input.length; i++) {
      input[i] = (i % size) / size;
    }
    const output = applyClahe(input, size, size, { clipLimit: 2.0, gridSize: 4 });
    expect(output.length).toBe(input.length);
    for (let i = 0; i < output.length; i++) {
      expect(output[i]).toBeGreaterThanOrEqual(0);
      expect(output[i]).toBeLessThanOrEqual(1);
    }
  });

  it('enhances contrast in low-contrast regions', () => {
    const size = 64;
    const input = new Float32Array(size * size);
    // Flat low contrast around 0.5
    input.fill(0.5);
    // Put a slight step in the center
    for (let y = 20; y < 44; y++) {
      for (let x = 20; x < 44; x++) {
        input[y * size + x] = 0.52;
      }
    }

    const output = applyClahe(input, size, size, { clipLimit: 3.0, gridSize: 4 });
    // Equalization will spread the difference between 0.5 and 0.52
    const diffBefore = input[32 * size + 32] - input[10 * size + 10];
    const diffAfter = output[32 * size + 32] - output[10 * size + 10];
    expect(diffAfter).toBeGreaterThan(diffBefore);
  });

  it('respects different grid sizes without crashing', () => {
    const size = 32;
    const input = new Float32Array(size * size);
    for (let i = 0; i < input.length; i++) input[i] = 0.4;
    const out2 = applyClahe(input, size, size, { gridSize: 2 });
    const out8 = applyClahe(input, size, size, { gridSize: 8 });
    expect(out2.length).toBe(size * size);
    expect(out8.length).toBe(size * size);
  });
});
