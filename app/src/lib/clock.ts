/** Server clock. Tests can pin it; the browser never supplies authoritative event times. */
let fixed: Date | null = null;

export const clock = {
  now(): Date {
    return fixed ? new Date(fixed.getTime()) : new Date();
  },
  iso(): string {
    return clock.now().toISOString();
  },
  set(d: Date | null) {
    fixed = d;
  },
  advance(ms: number) {
    if (!fixed) fixed = new Date();
    fixed = new Date(fixed.getTime() + ms);
  },
};

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

const TZ = 'Europe/London';
const fmtDateTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fmtParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function fmtDT(iso?: string | null): string {
  return iso ? fmtDateTime.format(new Date(iso)) : '—';
}
export function fmtD(iso?: string | null): string {
  return iso ? fmtDate.format(new Date(iso)) : '—';
}
export function fmtT(iso?: string | null): string {
  return iso ? fmtTime.format(new Date(iso)) : '—';
}

/** Local (Europe/London) wall-clock parts of an instant. */
export function londonParts(iso: string | Date) {
  const parts = Object.fromEntries(fmtParts.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, min: +parts.minute };
}

/** YYYY-MM-DD for the London calendar date of an instant. */
export function londonDate(iso: string | Date): string {
  const p = londonParts(iso);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Converts a London wall-clock "YYYY-MM-DDTHH:mm" (as from datetime-local) to a UTC ISO string. */
export function fromLocalInput(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(local.trim());
  if (!m) throw new Error(`Invalid date/time: ${local}`);
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  // Correct for the London offset at that instant (handles BST/GMT).
  const p = londonParts(new Date(guess));
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  const offset = asUtc - guess;
  return new Date(guess - offset).toISOString();
}

/** UTC ISO -> "YYYY-MM-DDTHH:mm" London wall clock for datetime-local inputs. */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const p = londonParts(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`;
}

export function londonDayStart(date: string): string {
  return fromLocalInput(`${date}T00:00`);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function relative(iso: string | null | undefined, now = clock.now()): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diff);
  let s: string;
  if (abs < HOUR) s = `${Math.round(abs / MIN)}m`;
  else if (abs < 2 * DAY) s = `${Math.round(abs / HOUR)}h`;
  else s = `${Math.round(abs / DAY)}d`;
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}
