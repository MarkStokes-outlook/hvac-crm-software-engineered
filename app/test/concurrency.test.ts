import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import * as Inv from '../src/domain/inventory.ts';
import { count, makeEnv, one, type TestEnv } from './helpers.ts';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'fixtures', 'race-worker.ts');
const tsx = path.join(here, '..', 'node_modules', '.bin', 'tsx');

let env: TestEnv;
before(() => {
  env = makeEnv('race');
});
after(() => env.close());

/** Runs n separate processes at once, each trying to take `qty` of the item. */
async function race(mode: 'reserve' | 'transfer', opts: { n: number; itemId: number; locationId: number; qty: number; jobId?: number; toLocation?: number }) {
  const attempts = Array.from({ length: opts.n }, () =>
    run(tsx, [worker, env.file, mode, String(opts.itemId), String(opts.locationId), String(opts.qty), String(env.actors.mick.id), String(opts.jobId ?? '')], {
      env: { ...process.env, RACE_TO_LOCATION: String(opts.toLocation ?? '') },
    })
      .then(() => ({ ok: true, refused: false }))
      .catch((err: { code?: number; stderr?: string }) => ({ ok: false, refused: err.code === 3, stderr: err.stderr ?? '' })),
  );
  return Promise.all(attempts);
}

describe('contested stock across processes (AC-060-02, AC-061-02)', () => {
  it('lets exactly the available quantity be taken, and refuses the rest', async () => {
    const { db, actors } = env;
    const location = one<{ id: number }>(db, `SELECT id FROM stock_locations WHERE code = 'WH-BURY'`).id;
    const item = one<{ id: number }>(db, `SELECT id FROM stock_items WHERE sku = 'PMP-MINI-OR'`).id;

    // Put a known, small quantity in play at this location: eight processes will chase five pumps.
    // Availability is per location, which is exactly what a reservation draws from.
    const here = Inv.availableAt(db, item, location);
    if (here < 5) {
      Inv.receiveGoods(db, actors.mick, {
        supplier: 'Race setup',
        location_id: String(location),
        line_item_id: [String(item)],
        line_qty_received: [String(5 - here)],
        line_condition: ['good'],
      });
    } else if (here > 5) {
      Inv.reserve(db, actors.mick, {
        item_id: String(item),
        location_id: String(location),
        qty: String(here - 5),
        purpose: 'Park the surplus so the race is for exactly five',
        owner_user_id: String(actors.mick.id),
        required_by: new Date(Date.now() + 86_400_000).toISOString().slice(0, 16),
        review_at: new Date(Date.now() + 172_800_000).toISOString().slice(0, 16),
        reallocation_consequence: 'n/a',
      });
    }
    const startOnHand = Inv.itemSummary(db, item).on_hand;
    assert.equal(Inv.availableAt(db, item, location), 5, 'the race starts with five available at the depot');

    const job = one<{ id: number }>(db, `SELECT id FROM jobs WHERE op_status NOT IN ('operationally_complete','cancelled') LIMIT 1`).id;
    const results = await race('reserve', { n: 8, itemId: item, locationId: location, qty: 1, jobId: job });

    const succeeded = results.filter((r) => r.ok).length;
    const refused = results.filter((r) => !r.ok && r.refused).length;
    const broke = results.filter((r) => !r.ok && !r.refused);
    assert.deepEqual(broke, [], `no process should fail for any reason other than a clean refusal: ${JSON.stringify(broke)}`);
    assert.equal(succeeded, 5, 'exactly the available quantity is handed out');
    assert.equal(refused, 3, 'the rest are told the stock has gone, not given it anyway');

    const end = Inv.itemSummary(db, item);
    assert.equal(Inv.availableAt(db, item, location), 0, 'availability at the contested location lands exactly on zero');
    assert.equal(end.on_hand, startOnHand, 'nothing was created or destroyed — it only changed state');
    assert.equal(count(db, 'SELECT COUNT(*) n FROM stock_balances WHERE qty < 0'), 0, 'no balance ever goes negative');
    assert.equal(count(db, `SELECT COUNT(*) n FROM reservations WHERE item_id = ? AND status = 'active' AND job_id = ?`, item, job), 5, 'five reservations exist, one per successful process');
    assert.equal(count(db, `SELECT COUNT(*) n FROM stock_movements WHERE item_id = ? AND movement_type = 'reserve' AND job_id = ?`, item, job), 5, 'the ledger records exactly the five that happened');
  });

  it('keeps transfers of the same stock consistent under contention', async () => {
    const { db } = env;
    const from = one<{ id: number }>(db, `SELECT id FROM stock_locations WHERE code = 'WH-BURY'`).id;
    const to = one<{ id: number }>(db, `SELECT id FROM stock_locations WHERE code = 'VAN-SAM'`).id;
    const item = one<{ id: number }>(db, `SELECT id FROM stock_items WHERE sku = 'CON-3P-25A'`).id;

    const startFrom = Inv.availableAt(db, item, from);
    const startTo = Inv.availableAt(db, item, to);
    const results = await race('transfer', { n: 6, itemId: item, locationId: from, qty: 2, toLocation: to });

    const succeeded = results.filter((r) => r.ok).length;
    const expected = Math.floor(startFrom / 2);
    assert.equal(succeeded, Math.min(6, expected), 'only as many transfers succeed as there was stock for');
    assert.equal(Inv.availableAt(db, item, from), startFrom - succeeded * 2);
    assert.equal(Inv.availableAt(db, item, to), startTo + succeeded * 2, 'every unit that left one place arrived at the other');
    assert.equal(count(db, 'SELECT COUNT(*) n FROM stock_balances WHERE qty < 0'), 0);
  });

  it('does not double-issue a part when the same submission is retried', async () => {
    const { db } = env;
    const item = one<{ id: number }>(db, `SELECT id FROM stock_items WHERE sku = 'FUSE-10A'`).id;

    const live = one<{ id: number; engineer_user_id: number; username: string; role: string; display_name: string }>(
      db,
      `SELECT a.id, a.engineer_user_id, u.username, u.role, u.display_name FROM attendances a JOIN users u ON u.id = a.engineer_user_id WHERE a.status IN ('on_site','working') LIMIT 1`,
    );
    const engineer = { id: live.engineer_user_id, role: live.role as 'engineer', name: live.display_name };
    const attendance = { id: live.id };
    const body = { item_id: String(item), qty: '2', idem_key: 'retry-key-1' };

    const van = one<{ van_location_id: number }>(db, 'SELECT van_location_id FROM users WHERE id = ?', engineer.id).van_location_id;
    const before = Inv.availableAt(db, item, van);

    Inv.issueToAttendance(db, engineer, attendance.id, body);
    Inv.issueToAttendance(db, engineer, attendance.id, body); // the engineer taps twice on a bad signal

    assert.equal(Inv.availableAt(db, item, van), before - 2, 'the part leaves the van once');
    assert.equal(count(db, `SELECT COUNT(*) n FROM stock_movements WHERE idem_key = 'retry-key-1'`), 1);
    assert.equal(count(db, `SELECT COUNT(*) n FROM attendance_materials WHERE attendance_id = ? AND item_id = ?`, attendance.id, item), 1);
  });
});
