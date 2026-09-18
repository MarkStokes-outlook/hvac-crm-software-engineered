/** Minimal auto-escaping HTML templating. Interpolations are escaped unless wrapped in SafeHtml. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

type Part = SafeHtml | string | number | boolean | null | undefined | Part[];

function render(v: Part): string {
  if (v === null || v === undefined || v === false) return '';
  if (v === true) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (v instanceof SafeHtml) return v.value;
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Part[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

export function when(cond: unknown, fn: () => SafeHtml | string): SafeHtml | string {
  return cond ? fn() : '';
}
