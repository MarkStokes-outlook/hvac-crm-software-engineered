import type { DB } from '../db/db.ts';

const PAD: Record<string, number> = { J: 5, A: 5, Q: 4, CUS: 4, S: 4, AS: 5, RS: 5, GR: 4, EH: 4, V: 4, P: 4, CT: 3 };

/** Allocates the next human-readable reference (e.g. J-10042). Call inside the owning transaction. */
export function nextRef(db: DB, prefix: string, start = 1000): string {
  const row = db.prepare('UPDATE sequences SET value = value + 1 WHERE name = ? RETURNING value').get(prefix) as { value: number } | undefined;
  let value = row?.value;
  if (value === undefined) {
    value = start + 1;
    db.prepare('INSERT INTO sequences (name, value) VALUES (?, ?)').run(prefix, value);
  }
  return `${prefix}-${String(value).padStart(PAD[prefix] ?? 4, '0')}`;
}
