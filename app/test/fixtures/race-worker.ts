/**
 * One competing process in the inventory race test. Opens its own connection to the shared
 * database file and tries to take stock, exactly as a second coordinator on another machine would.
 *
 * Usage: race-worker.ts <dbFile> <mode> <itemId> <locationId> <qty> <actorId> <jobId>
 * Exits 0 when the take succeeded, 3 when it was correctly refused, 1 on any other failure.
 */
import { openDb } from '../../src/db/db.ts';
import { ConflictError } from '../../src/lib/errors.ts';
import type { Actor, Role } from '../../src/auth/policy.ts';
import * as Inv from '../../src/domain/inventory.ts';

const [file, mode, itemId, locationId, qty, actorId, jobId] = process.argv.slice(2);
const db = openDb(file);
const row = db.prepare('SELECT id, role, display_name FROM users WHERE id = ?').get(Number(actorId)) as { id: number; role: Role; display_name: string };
const actor: Actor = { id: row.id, role: row.role, name: row.display_name };

try {
  if (mode === 'reserve') {
    Inv.reserve(db, actor, {
      item_id: itemId,
      location_id: locationId,
      qty,
      job_id: jobId,
      purpose: `Race worker ${process.pid}`,
      owner_user_id: actorId,
      required_by: new Date(Date.now() + 86_400_000).toISOString().slice(0, 16),
      review_at: new Date(Date.now() + 172_800_000).toISOString().slice(0, 16),
      reallocation_consequence: 'Test',
    });
  } else {
    Inv.transfer(db, actor, {
      item_id: itemId,
      from_location_id: locationId,
      to_location_id: process.env.RACE_TO_LOCATION!,
      qty,
      reason: `Race worker ${process.pid}`,
    });
  }
  process.exit(0);
} catch (err) {
  if (err instanceof ConflictError) process.exit(3);
  console.error((err as Error).message);
  process.exit(1);
} finally {
  db.close();
}
