import { DomainError } from './errors.ts';
import { fromLocalInput } from './clock.ts';
import { parsePence } from './money.ts';

type Body = Record<string, unknown>;

/**
 * Server-side form validation (NFR-005). Collects field errors and throws a single
 * DomainError so the UI can show every problem at once.
 */
export class Form {
  errors: Record<string, string> = {};
  constructor(readonly body: Body) {}

  private raw(name: string): string {
    const v = this.body[name];
    if (Array.isArray(v)) return String(v[v.length - 1] ?? '').trim();
    return v === undefined || v === null ? '' : String(v).trim();
  }

  has(name: string): boolean {
    return this.raw(name) !== '';
  }

  str(name: string, label: string, max = 4000): string {
    const v = this.raw(name);
    if (!v) this.errors[name] = `${label} is required.`;
    else if (v.length > max) this.errors[name] = `${label} is too long (max ${max}).`;
    return v;
  }

  opt(name: string, max = 4000): string | null {
    const v = this.raw(name);
    if (v.length > max) this.errors[name] = `Too long (max ${max}).`;
    return v || null;
  }

  bool(name: string): boolean {
    const v = this.raw(name);
    return v === 'on' || v === 'true' || v === '1' || v === 'yes';
  }

  int(name: string, label: string, opts: { min?: number; max?: number; required?: boolean } = {}): number | null {
    const v = this.raw(name);
    if (!v) {
      if (opts.required) this.errors[name] = `${label} is required.`;
      return null;
    }
    if (!/^-?\d+$/.test(v)) {
      this.errors[name] = `${label} must be a whole number.`;
      return null;
    }
    const n = parseInt(v, 10);
    if (opts.min !== undefined && n < opts.min) this.errors[name] = `${label} must be at least ${opts.min}.`;
    if (opts.max !== undefined && n > opts.max) this.errors[name] = `${label} must be at most ${opts.max}.`;
    return n;
  }

  reqInt(name: string, label: string, opts: { min?: number; max?: number } = {}): number {
    return this.int(name, label, { ...opts, required: true }) ?? 0;
  }

  num(name: string, label: string, required = false): number | null {
    const v = this.raw(name);
    if (!v) {
      if (required) this.errors[name] = `${label} is required.`;
      return null;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      this.errors[name] = `${label} must be a number.`;
      return null;
    }
    return n;
  }

  pence(name: string, label: string, required = false): number | null {
    const v = this.raw(name);
    if (!v) {
      if (required) this.errors[name] = `${label} is required.`;
      return null;
    }
    try {
      return parsePence(v);
    } catch {
      this.errors[name] = `${label} must be an amount like 1250.00.`;
      return null;
    }
  }

  oneOf<T extends string>(name: string, label: string, allowed: readonly T[], required = true): T {
    const v = this.raw(name);
    if (!v) {
      if (required) this.errors[name] = `${label} is required.`;
      return null as unknown as T;
    }
    if (!allowed.includes(v as T)) this.errors[name] = `${label} is not a valid option.`;
    return v as T;
  }

  optOneOf<T extends string>(name: string, label: string, allowed: readonly T[]): T | null {
    return (this.oneOf(name, label, allowed, false) as T) || null;
  }

  /** datetime-local (Europe/London wall clock) -> UTC ISO. */
  dt(name: string, label: string, required = true): string | null {
    const v = this.raw(name);
    if (!v) {
      if (required) this.errors[name] = `${label} is required.`;
      return null;
    }
    try {
      return fromLocalInput(v);
    } catch {
      this.errors[name] = `${label} is not a valid date/time.`;
      return null;
    }
  }

  reqDt(name: string, label: string): string {
    return this.dt(name, label, true) ?? '';
  }

  date(name: string, label: string, required = true): string | null {
    const v = this.raw(name);
    if (!v) {
      if (required) this.errors[name] = `${label} is required.`;
      return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      this.errors[name] = `${label} must be a date.`;
      return null;
    }
    return v;
  }

  list(name: string): string[] {
    const v = this.body[name];
    if (v === undefined || v === null || v === '') return [];
    return (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
  }

  check(cond: unknown, name: string, message: string) {
    if (!cond && !this.errors[name]) this.errors[name] = message;
  }

  done(): void {
    if (Object.keys(this.errors).length) {
      throw new DomainError(Object.values(this.errors)[0] + (Object.keys(this.errors).length > 1 ? ` (and ${Object.keys(this.errors).length - 1} more)` : ''), this.errors);
    }
  }
}
