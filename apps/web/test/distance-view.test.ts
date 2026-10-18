import { describe, expect, it } from 'vitest';
import {
  ACUITY_BLUR_MM_PER_M,
  distanceBlurPx,
  DistanceViewController,
} from '../src/views/studio-view/distance-view.js';

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

  it('gerencia referência e estado desatualizado (T7)', () => {
    const simCanvas = {
      clientWidth: 600,
      width: 600,
      style: {},
    } as unknown as HTMLCanvasElement;

    const compareCanvas = {
      clientWidth: 500,
      width: 500,
      height: 500,
      hidden: true,
      style: {},
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      }),
    } as unknown as HTMLCanvasElement;

    const compareToggle = {
      checked: false,
      disabled: false,
      addEventListener: () => {},
    } as unknown as HTMLInputElement;

    const caption = {
      textContent: '',
      classList: {
        add: (cls: string) => (caption as unknown as { classes: Set<string> }).classes.add(cls),
        remove: (cls: string) => (caption as unknown as { classes: Set<string> }).classes.delete(cls),
      },
      classes: new Set<string>(),
    } as unknown as HTMLElement;

    const ctrl = new DistanceViewController(
      {
        simCanvas,
        compareCanvas,
        compareToggle,
        caption,
      },
      () => 622,
      () => 1,
    );

    // No início sem referência, o toggle de comparar inicia desabilitado
    expect(compareToggle.disabled).toBe(true);

    // setReference com buffer válido habilita o toggle sem forçar comparação
    const rgba = new Uint8ClampedArray(10 * 10 * 4);
    ctrl.setReference(rgba, 10, 10);
    expect(compareToggle.disabled).toBe(false);
    expect(compareToggle.checked).toBe(false);

    // Ao ativar compareToggle
    compareToggle.checked = true;
    ctrl.refresh();
    expect(compareCanvas.hidden).toBe(false);

    // setStale(true) esconde comparação, desmarca toggle, desabilita toggle e atualiza legenda
    ctrl.setStale(true);
    expect(compareToggle.checked).toBe(false);
    expect(compareToggle.disabled).toBe(true);
    expect(compareCanvas.hidden).toBe(true);
    expect(caption.textContent).toContain('desatualizado');

    // setStale(false) restaura comportamento normal e reabilita toggle (pois tem referência)
    ctrl.setStale(false);
    expect(compareToggle.disabled).toBe(false);
    compareToggle.checked = true;
    ctrl.refresh();
    expect(compareCanvas.hidden).toBe(false);
    expect(caption.textContent).not.toContain('desatualizado');

    // clearReference() limpa e desabilita toggle
    ctrl.clearReference();
    expect(compareCanvas.hidden).toBe(true);
    expect(compareToggle.disabled).toBe(true);
    expect(compareToggle.checked).toBe(false);
  });
});
