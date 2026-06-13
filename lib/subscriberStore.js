// Almacén de suscriptores al newsletter. PostgreSQL si hay DATABASE_URL, si no archivo.
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { getPool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let backend = null;

async function makePgBackend() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id           SERIAL PRIMARY KEY,
      email        TEXT UNIQUE NOT NULL,
      unsubscribed BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  return {
    async list() {
      const r = await pool.query('SELECT id, email, unsubscribed, created_at FROM subscribers ORDER BY created_at DESC, id DESC');
      return r.rows;
    },
    async add(email) {
      // Si ya existía y se había dado de baja, lo reactiva.
      await pool.query(
        `INSERT INTO subscribers (email) VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET unsubscribed = false`,
        [email]
      );
    },
    async unsubscribe(email) {
      const r = await pool.query('UPDATE subscribers SET unsubscribed = true WHERE email = $1', [email]);
      return r.rowCount > 0;
    },
    async remove(id) {
      const r = await pool.query('DELETE FROM subscribers WHERE id = $1', [id]);
      return r.rowCount > 0;
    },
    async isActive(email) {
      const r = await pool.query('SELECT 1 FROM subscribers WHERE email = $1 AND unsubscribed = false', [email]);
      return r.rowCount > 0;
    },
  };
}

async function makeFileBackend() {
  const file = path.join(__dirname, '..', 'data', 'subscribers.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let state = { seq: 0, rows: [] };
  try {
    state = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    state = { seq: 0, rows: [] };
  }
  const save = () => fs.writeFile(file, JSON.stringify(state, null, 2));
  await save();
  return {
    async list() {
      return state.rows.slice().reverse();
    },
    async add(email) {
      const ex = state.rows.find((r) => r.email === email);
      if (ex) { ex.unsubscribed = false; }
      else state.rows.push({ id: ++state.seq, email, unsubscribed: false, created_at: new Date().toISOString() });
      await save();
    },
    async unsubscribe(email) {
      const r = state.rows.find((x) => x.email === email);
      if (!r) return false;
      r.unsubscribed = true;
      await save();
      return true;
    },
    async remove(id) {
      const before = state.rows.length;
      state.rows = state.rows.filter((r) => r.id !== Number(id));
      const changed = state.rows.length < before;
      if (changed) await save();
      return changed;
    },
    async isActive(email) {
      return state.rows.some((r) => r.email === email && !r.unsubscribed);
    },
  };
}

export async function initSubscriberStore({ databaseUrl }) {
  backend = databaseUrl ? await makePgBackend() : await makeFileBackend();
  console.log('Almacén de suscriptores:', databaseUrl ? 'PostgreSQL' : 'archivo local');
  return backend;
}

export function subscriberStore() {
  if (!backend) throw new Error('El almacén de suscriptores no está inicializado.');
  return backend;
}
