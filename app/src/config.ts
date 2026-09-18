import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

export const config = {
  root,
  dbFile: process.env.DATABASE_FILE ? path.resolve(process.env.DATABASE_FILE) : path.join(root, 'data', 'frostline.db'),
  uploadDir: process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(root, 'data', 'uploads'),
  port: parseInt(process.env.PORT ?? '3000', 10),
  sessionCookie: 'frostline_sid',
  isProd: process.env.NODE_ENV === 'production',
};
