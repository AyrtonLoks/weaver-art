import { describe, expect, it } from 'vitest';
import { clampToInput, finiteOr, readValidNumber, setInputValue } from '../src/ui-utils/inputs.js';

describe('UI Input Helpers (ui-utils/inputs.ts)', () => {
  it('readValidNumber returns number or null on invalid/out-of-range', () => {
    const el = { value: '', min: '20', max: '1000' } as unknown as HTMLInputElement;
    expect(readValidNumber(el)).toBeNull();

    el.value = '   ';
    expect(readValidNumber(el)).toBeNull();

    el.value = 'abc';
    expect(readValidNumber(el)).toBeNull();

    el.value = '10'; // below min
    expect(readValidNumber(el)).toBeNull();

    el.value = '2000'; // above max
    expect(readValidNumber(el)).toBeNull();

    el.value = '250';
    expect(readValidNumber(el)).toBe(250);

    el.value = '  622.5 ';
    expect(readValidNumber(el)).toBe(622.5);
  });

  it('clampToInput clamps values to min/max', () => {
    const el = { value: '5', min: '20', max: '1000' } as unknown as HTMLInputElement;
    expect(clampToInput(el, 200)).toBe(20);

    el.value = '1500';
    expect(clampToInput(el, 200)).toBe(1000);

    el.value = '350';
    expect(clampToInput(el, 200)).toBe(350);

    el.value = '';
    expect(clampToInput(el, 200)).toBe(200);
  });

  it('finiteOr accepts 0 and negative values, fallbacks on empty or NaN', () => {
    expect(finiteOr('0', 10)).toBe(0);
    expect(finiteOr('-5', 10)).toBe(-5);
    expect(finiteOr('1.25', 10)).toBe(1.25);
    expect(finiteOr('', 10)).toBe(10);
    expect(finiteOr('   ', 10)).toBe(10);
    expect(finiteOr('invalid', 10)).toBe(10);
    expect(finiteOr(null, 10)).toBe(10);
    expect(finiteOr(undefined, 10)).toBe(10);
    expect(finiteOr(0, 10)).toBe(0);
  });

  it('setInputValue avoids rewriting activeElement or equivalent numeric value', () => {
    const input = { value: '7', type: 'text' } as unknown as HTMLInputElement;
    setInputValue(input, '7');
    expect(input.value).toBe('7');

    // Equivalent numeric value: "622" vs 622.0 should not overwrite to "622" if already 622
    input.value = '622';
    setInputValue(input, 622);
    expect(input.value).toBe('622');

    // Changing number
    setInputValue(input, 500);
    expect(input.value).toBe('500');

    // Protects actively edited element (document.activeElement)
    const originalDoc = globalThis.document;
    (globalThis as unknown as { document: unknown }).document = { activeElement: input };
    input.value = '42';
    setInputValue(input, 600);
    expect(input.value).toBe('42');
    (globalThis as unknown as { document: unknown }).document = originalDoc;
  });
});
