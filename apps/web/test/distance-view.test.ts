import { describe, expect, it } from 'vitest';
import { ACUITY_BLUR_MM_PER_M, distanceBlurPx } from '../src/views/studio-view/distance-view.js';

describe('Vista à distância (desfoque por acuidade visual)', () => {
  it('σ cresce linearmente com a distância e com a escala px/mm do canvas', () => {
    // Aro de 622 mm exibido com 622 px CSS => 1 px/mm; a 3 m: σ = 3 · 0,6 mm = 1,8 px.
    expect(distanceBlurPx(3, 622, 622)).toBeCloseTo(3 * ACUITY_BLUR_MM_PER_M, 6);
    expect(distanceBlurPx(6, 622, 622)).toBeCloseTo(2 * distanceBlurPx(3, 622, 622), 6);
    // Canvas com metade da largura => metade do σ em px.
    expect(distanceBlurPx(3, 311, 622)).toBeCloseTo(distanceBlurPx(3, 622, 622) / 2, 6);
    // Zoom 2x na simulação => o dobro de px por mm.
    expect(distanceBlurPx(3, 622, 622, 2)).toBeCloseTo(2 * distanceBlurPx(3, 622, 622), 6);
  });

  it('entradas inválidas não desfocam', () => {
    expect(distanceBlurPx(0, 600, 622)).toBe(0);
    expect(distanceBlurPx(3, 0, 622)).toBe(0);
    expect(distanceBlurPx(3, 600, 0)).toBe(0);
    expect(distanceBlurPx(Number.NaN, 600, 622)).toBe(0);
  });
});
