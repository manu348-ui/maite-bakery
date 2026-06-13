// Almacén de pedidos. PostgreSQL si hay DATABASE_URL, si no archivo local.
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { getPool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ORDER_STATUSES = ['nuevo', 'preparando', 'entregado', 'cancelado'];

let backend = null;

async function makePgBackend() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id              SERIAL PRIMARY KEY,
      customer_name   TEXT NOT NULL,
      phone           TEXT NOT NULL DEFAULT '',
      delivery_method TEXT NOT NULL DEFAULT 'recogida',
      address         TEXT NOT NULL DEFAULT '',
      items           JSONB NOT NULL DEFAULT '[]',
      subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,
      tax             NUMERIC(10,2) NOT NULL DEFAULT 0,
      total           NUMERIC(10,2) NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'nuevo',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Para bases creadas antes de sumar el envío a domicilio.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT ''`);
  const map = (r) => ({ ...r, subtotal: Number(r.subtotal), tax: Number(r.tax), total: Number(r.total) });
  return {
    async list() {
      const r = await pool.query('SELECT * FROM orders ORDER BY created_at DESC, id DESC');
      return r.rows.map(map);
    },
    async get(id) {
      const r = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
      return r.rows[0] ? map(r.rows[0]) : null;
    },
    async add(o) {
      const r = await pool.query(
        `INSERT INTO orders (customer_name, phone, delivery_method, address, items, subtotal, tax, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [o.customer_name, o.phone, o.delivery_method, o.address || '', JSON.stringify(o.items), o.subtotal, o.tax, o.total]
      );
      return map(r.rows[0]);
    },
    async setStatus(id, status) {
      const r = await pool.query('UPDATE orders SET status = $2 WHERE id = $1 RETURNING id', [id, status]);
      return r.rowCount > 0;
    },
    async remove(id) {
      const r = await pool.query('DELETE FROM orders WHERE id = $1', [id]);
      return r.rowCount > 0;
    },
  };
}

async function makeFileBackend() {
  const file = path.join(__dirname, '..', 'data', 'orders.json');
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
    async get(id) {
      return state.rows.find((r) => r.id === Number(id)) || null;
    },
    async add(o) {
      const row = {
        id: ++state.seq,
        customer_name: o.customer_name,
        phone: o.phone,
        delivery_method: o.delivery_method,
        address: o.address || '',
        items: o.items,
        subtotal: o.subtotal,
        tax: o.tax,
        total: o.total,
        status: 'nuevo',
        created_at: new Date().toISOString(),
      };
      state.rows.push(row);
      await save();
      return row;
    },
    async setStatus(id, status) {
      const row = state.rows.find((r) => r.id === Number(id));
      if (!row) return false;
      row.status = status;
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
  };
}

export async function initOrderStore({ databaseUrl }) {
  backend = databaseUrl ? await makePgBackend() : await makeFileBackend();
  console.log('Almacén de pedidos:', databaseUrl ? 'PostgreSQL' : 'archivo local');
  return backend;
}

export function orderStore() {
  if (!backend) throw new Error('El almacén de pedidos no está inicializado.');
  return backend;
}
