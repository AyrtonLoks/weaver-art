/**
 * Input helpers for Weaver Art UI (DOM / Node safe).
 */

/** Atualiza um input sem atropelar a edição do usuário nem gerar ruído de formatação. */
export function setInputValue(el: HTMLInputElement | HTMLSelectElement, v: number | string): void {
  if (typeof document !== 'undefined' && document.activeElement === el) return;
  const s = String(v);
  if (el.value === s) return;
  const isInput = typeof HTMLInputElement !== 'undefined' ? el instanceof HTMLInputElement : 'type' in el;
  const isCheckbox = 'type' in el && el.type === 'checkbox';
  if (isInput && !isCheckbox && s !== '' && el.value !== '' && Number(el.value) === Number(s)) {
    return;
  }
  el.value = s;
}

/** Retorna o valor do input se for válido (finito e dentro de min/max); caso contrário, null. */
export function readValidNumber(el: HTMLInputElement): number | null {
  const raw = el.value.trim();
  if (raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  const min = el.min !== '' ? Number(el.min) : -Infinity;
  const max = el.max !== '' ? Number(el.max) : Infinity;
  return v >= min && v <= max ? v : null;
}

/** Limita o valor do input aos limites min/max definidos no elemento, ou retorna o fallback. */
export function clampToInput(el: HTMLInputElement, fallback: number): number {
  const raw = el.value.trim();
  const v = Number(raw);
  const min = el.min !== '' ? Number(el.min) : -Infinity;
  const max = el.max !== '' ? Number(el.max) : Infinity;
  return raw !== '' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Converte o valor de um input numérico, aceitando 0 (ao contrário de Number(x) || padrão). */
export function finiteOr(raw: string | number | undefined | null, fallback: number): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : fallback;
  if (typeof raw !== 'string') return fallback;
  const v = Number(raw);
  return raw.trim() !== '' && Number.isFinite(v) ? v : fallback;
}
