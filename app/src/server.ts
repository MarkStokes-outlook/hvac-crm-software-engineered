import { migrate, openDb } from './db/db.ts';
import { openDbReadOnly } from './db/db.ts';
import { config } from './config.ts';
import { createApp } from './web/app.ts';
import { providerFromEnv } from './ai/assistant.ts';

const db = openDb(config.dbFile);
const applied = migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

const users = (db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n;
if (users === 0) {
  console.error('No users found. Run "npm run db:reset" to create the database with demo data.');
  process.exit(1);
}

const readDb = openDbReadOnly(config.dbFile);
const provider = providerFromEnv();
const app = createApp({ db, readDb, provider, uploadDir: config.uploadDir });

const server = app.listen(config.port, () => {
  console.log(`FrostLine operations CRM listening on http://localhost:${config.port}`);
  console.log(`  database   : ${config.dbFile}`);
  console.log(`  uploads    : ${config.uploadDir}`);
  console.log(`  AI provider: ${provider.name}${provider.model ? ` (${provider.model})` : ' (deterministic, no API key needed)'}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      readDb?.close();
      process.exit(0);
    });
  });
}
