// Almacén de configuración (clave-valor). PostgreSQL si hay DATABASE_URL, si no archivo.
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { getPool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let backend = null;

async function makePgBackend(seed) {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `);
  for (const [k, v] of Object.entries(seed)) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
  return {
    async get(key, def = '') {
      const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      return r.rows[0] ? r.rows[0].value : def;
    },
    async set(key, value) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, value]
      );
    },
  };
}

async function makeFileBackend(seed) {
  const file = path.join(__dirname, '..', 'data', 'settings.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    data = {};
  }
  for (const [k, v] of Object.entries(seed)) {
    if (!(k in data)) data[k] = v;
  }
  const save = () => fs.writeFile(file, JSON.stringify(data, null, 2));
  await save();
  return {
    async get(key, def = '') {
      return key in data ? data[key] : def;
    },
    async set(key, value) {
      data[key] = value;
      await save();
    },
  };
}

export async function initSettingsStore({ databaseUrl, seed = {} }) {
  backend = databaseUrl ? await makePgBackend(seed) : await makeFileBackend(seed);
  console.log('Almacén de configuración:', databaseUrl ? 'PostgreSQL' : 'archivo local');
  return backend;
}

export function settingsStore() {
  if (!backend) throw new Error('El almacén de configuración no está inicializado.');
  return backend;
}
