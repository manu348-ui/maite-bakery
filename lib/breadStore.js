// Almacén de panes (inventario). PostgreSQL si hay DATABASE_URL, si no archivo local.
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { getPool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BREAD_STATUSES = ['in_stock', 'out_of_stock'];

// Panes iniciales (los del catálogo actual) para no arrancar con la lista vacía.
const SEED = [
  {
    name: 'Masa Madre Tradicional',
    description: 'Fermentación natural de 24 horas, trigo orgánico, sal marina.',
    price: 8.5,
    status: 'in_stock',
    image_url:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuCMcyBk9WoHX7diTAwrcJoQwO2bI6mJObxnOlYUbsHGQz8dHgV96-3dni8n6WvgWXBpTv0rvgjqP41anwg9V3rAtr3rk6LDnVmvmcwNgtY0nGjhlr0MATVUry5DLK-G7NE2Y63fgU0NNPk0Td4lJONdmt5hBrYqfjc6VNEILCcljUwvnbm9sCSc_SUWhDK6kFatOkLYTDUAp3zDl37ro1EpXIh6UJ3tinHbc2CE90LYMlqHbY1RSh15BS6bDHdCufY84HYbpHhA0X8',
  },
  {
    name: 'Cruasán de Mantequilla',
    description: 'Hojaldre de 72 capas elaborado con mantequilla francesa.',
    price: 4.25,
    status: 'in_stock',
    image_url:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuBaxemaIfOgyS2l8XWtF2un0vBrF2Yyx1-1gjf4-dZAMxMkdPi-Otd46KL98h4933YF7THl_EHWC8RovvLBE3ULU5ijmCOxotYWOh4h5G0oHXDHHzBEoxjOjudyexj4CGzYQ8N9hUQxkFwLH1g0albr7AyL4qCSmPGRnBOZ_Fo_n4tQNJUnqWLNk8DrPGx9M6EaWyav3dPv5pL-ZwnyjhTR5AuNDA4TntWgxiHqabn60GqkDrUMYX0XORmyVIlkXB6lI0Wga_Ahea8',
  },
  {
    name: 'Baguette Rústica',
    description: 'Corteza crujiente, miga aireada. Perfecto para cada día.',
    price: 3.5,
    status: 'out_of_stock',
    image_url:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuBrrNboevfTpBuBeShdxRoZWb5_AvKFrb9Pt68dGvvKkFNE4SuBzYqXoO9ZTVGmEK6mhCgEZ7wtMUDP0ujkdZLz-gWq52x0P2eZPmysXwVCSbGLZHcFejHwBqBOGXPhIrbEWwrqw5G6k0_Y72JQShMdUEazI8SomBTfPcRK5tMsPkEFF7pnoy04kTKIMmTRGYtJlnx8vFVzWM4T0cg8cXsvzHyU5sy_gRuP1uQvi8zU_cRWh9mUnafzpwJsCXjHXqrgCRbB5NP8HUI',
  },
];

let backend = null;

function clean(b) {
  return {
    name: String(b.name || '').trim(),
    description: String(b.description || '').trim(),
    price: Number.isFinite(Number(b.price)) ? Number(b.price) : 0,
    status: BREAD_STATUSES.includes(b.status) ? b.status : 'in_stock',
    image_url: String(b.image_url || '').trim(),
  };
}

// --------------------------------------------------------------------------
// Backend PostgreSQL
// --------------------------------------------------------------------------
async function makePgBackend() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS breads (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price       NUMERIC(10,2) NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'in_stock',
      image_url   TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const count = await pool.query('SELECT COUNT(*)::int AS n FROM breads');
  if (count.rows[0].n === 0) {
    for (const b of SEED) {
      const c = clean(b);
      await pool.query(
        'INSERT INTO breads (name, description, price, status, image_url) VALUES ($1,$2,$3,$4,$5)',
        [c.name, c.description, c.price, c.status, c.image_url]
      );
    }
  }

  const mapRow = (r) => ({ ...r, price: Number(r.price) });

  return {
    async list() {
      const r = await pool.query('SELECT * FROM breads ORDER BY created_at, id');
      return r.rows.map(mapRow);
    },
    async get(id) {
      const r = await pool.query('SELECT * FROM breads WHERE id = $1', [id]);
      return r.rows[0] ? mapRow(r.rows[0]) : null;
    },
    async add(data) {
      const c = clean(data);
      const r = await pool.query(
        `INSERT INTO breads (name, description, price, status, image_url)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [c.name, c.description, c.price, c.status, c.image_url]
      );
      return mapRow(r.rows[0]);
    },
    async update(id, data) {
      const c = clean(data);
      const r = await pool.query(
        `UPDATE breads SET name=$2, description=$3, price=$4, status=$5, image_url=$6
         WHERE id=$1 RETURNING *`,
        [id, c.name, c.description, c.price, c.status, c.image_url]
      );
      return r.rows[0] ? mapRow(r.rows[0]) : null;
    },
    async remove(id) {
      const r = await pool.query('DELETE FROM breads WHERE id=$1', [id]);
      return r.rowCount > 0;
    },
  };
}

// --------------------------------------------------------------------------
// Backend archivo JSON (solo desarrollo local)
// --------------------------------------------------------------------------
async function makeFileBackend() {
  const file = path.join(__dirname, '..', 'data', 'breads.json');
  await fs.mkdir(path.dirname(file), { recursive: true });

  let state = { seq: 0, rows: [] };
  try {
    state = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    for (const b of SEED) {
      state.rows.push({ id: ++state.seq, ...clean(b), created_at: new Date().toISOString() });
    }
  }
  const save = () => fs.writeFile(file, JSON.stringify(state, null, 2));
  await save();

  return {
    async list() {
      return state.rows.slice();
    },
    async get(id) {
      return state.rows.find((r) => r.id === Number(id)) || null;
    },
    async add(data) {
      const row = { id: ++state.seq, ...clean(data), created_at: new Date().toISOString() };
      state.rows.push(row);
      await save();
      return row;
    },
    async update(id, data) {
      const row = state.rows.find((r) => r.id === Number(id));
      if (!row) return null;
      Object.assign(row, clean(data));
      await save();
      return row;
    },
    async remove(id) {
      const before = state.rows.length;
      state.rows = state.rows.filter((r) => r.id !== Number(id));
      const changed = state.rows.length < before;
      if (changed) await save();
      return changed;
    },
  };
}

export async function initBreadStore({ databaseUrl }) {
  if (databaseUrl) {
    backend = await makePgBackend();
    console.log('Almacén de panes: PostgreSQL');
  } else {
    backend = await makeFileBackend();
    console.log('Almacén de panes: archivo local (data/breads.json)');
  }
  return backend;
}

export function breadStore() {
  if (!backend) throw new Error('El almacén de panes no está inicializado.');
  return backend;
}
