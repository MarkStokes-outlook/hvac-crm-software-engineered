import fs from 'node:fs';
import { migrate, openDb } from './db/db.ts';
import { seed } from './db/seed.ts';
import { config } from './config.ts';

const cmd = process.argv[2];

function open() {
  return openDb(config.dbFile);
}

switch (cmd) {
  case 'migrate': {
    const db = open();
    const ran = migrate(db);
    console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database already up to date.');
    db.close();
    break;
  }
  case 'seed': {
    const db = open();
    migrate(db);
    const existing = db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number };
    if (existing.n > 0) {
      console.error('Database already contains users. Use "npm run db:reset" to rebuild the demo dataset.');
      process.exit(1);
    }
    const t = Date.now();
    seed(db);
    console.log(`Seeded demo data in ${Date.now() - t}ms → ${config.dbFile}`);
    db.close();
    break;
  }
  case 'reset': {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = config.dbFile + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    if (fs.existsSync(config.uploadDir)) fs.rmSync(config.uploadDir, { recursive: true, force: true });
    const db = open();
    migrate(db);
    seed(db);
    console.log(`Rebuilt database with demo data → ${config.dbFile}`);
    db.close();
    break;
  }
  default:
    console.log('Usage: tsx src/cli.ts <migrate|seed|reset>');
    process.exit(1);
}
