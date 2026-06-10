// Almacén de administradores autorizados.
// - Si hay DATABASE_URL -> PostgreSQL (persistente, para producción en Render).
// - Si no -> archivo JSON local en data/admins.json (solo para desarrollo).
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(e) {
  return typeof e === 'string' && EMAIL_RE.test(e);
}

let backend = null;

function sslFor(url) {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return false;
    // Host interno de Render (sin punto) no usa SSL; externos (con dominio) sí.
    return host.includes('.') ? { rejectUnauthorized: false } : false;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// Backend PostgreSQL
// --------------------------------------------------------------------------
async function makePgBackend(databaseUrl, primaryEmails) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: sslFor(databaseUrl) });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      email      TEXT PRIMARY KEY,
      role       TEXT NOT NULL DEFAULT 'admin',
      active     BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const email of primaryEmails) {
    await pool.query(
      `INSERT INTO admins (email, role, active) VALUES ($1, 'primary', true)
       ON CONFLICT (email) DO UPDATE SET role = 'primary', active = true`,
      [email]
    );
  }

  return {
    async list() {
      const r = await pool.query(
        `SELECT email, role, active, created_at FROM admins
         ORDER BY (role = 'primary') DESC, email`
      );
      return r.rows;
    },
    async get(email) {
      const r = await pool.query('SELECT email, role, active FROM admins WHERE email = $1', [email]);
      return r.rows[0] || null;
    },
    async add(email) {
      await pool.query(
        `INSERT INTO admins (email, role, active) VALUES ($1, 'admin', true)
         ON CONFLICT (email) DO UPDATE SET active = true`,
        [email]
      );
    },
    async remove(email) {
      const r = await pool.query(`DELETE FROM admins WHERE email = $1 AND role <> 'primary'`, [email]);
      return r.rowCount > 0;
    },
    async setActive(email, active) {
      // No se permite desactivar a un administrador principal.
      const r = await pool.query(
        `UPDATE admins SET active = $2 WHERE email = $1 AND (role <> 'primary' OR $2 = true)`,
        [email, active]
      );
      return r.rowCount > 0;
    },
    async isAllowed(email) {
      const r = await pool.query('SELECT 1 FROM admins WHERE email = $1 AND active = true', [email]);
      return r.rowCount > 0;
    },
  };
}

// --------------------------------------------------------------------------
// Backend archivo JSON (solo desarrollo local)
// --------------------------------------------------------------------------
async function makeFileBackend(primaryEmails) {
  const file = path.join(__dirname, '..', 'data', 'admins.json');
  await fs.mkdir(path.dirname(file), { recursive: true });

  let rows = [];
  try {
    rows = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    rows = [];
  }
  const save = () => fs.writeFile(file, JSON.stringify(rows, null, 2));

  for (const email of primaryEmails) {
    const ex = rows.find((r) => r.email === email);
    if (ex) {
      ex.role = 'primary';
      ex.active = true;
    } else {
      rows.push({ email, role: 'primary', active: true, created_at: new Date().toISOString() });
    }
  }
  await save();

  const sorted = () =>
    rows
      .slice()
      .sort(
        (a, b) =>
          (b.role === 'primary') - (a.role === 'primary') || a.email.localeCompare(b.email)
      );

  return {
    async list() {
      return sorted();
    },
    async get(email) {
      return rows.find((r) => r.email === email) || null;
    },
    async add(email) {
      const ex = rows.find((r) => r.email === email);
      if (ex) ex.active = true;
      else rows.push({ email, role: 'admin', active: true, created_at: new Date().toISOString() });
      await save();
    },
    async remove(email) {
      const before = rows.length;
      rows = rows.filter((r) => !(r.email === email && r.role !== 'primary'));
      const changed = rows.length < before;
      if (changed) await save();
      return changed;
    },
    async setActive(email, active) {
      const r = rows.find((x) => x.email === email);
      if (!r) return false;
      if (r.role === 'primary' && !active) return false;
      r.active = active;
      await save();
      return true;
    },
    async isAllowed(email) {
      return rows.some((r) => r.email === email && r.active);
    },
  };
}

export async function initAdminStore({ databaseUrl, primaryEmails }) {
  const primaries = (primaryEmails || []).map((e) => e.toLowerCase());
  if (databaseUrl) {
    backend = await makePgBackend(databaseUrl, primaries);
    console.log('Almacén de admins: PostgreSQL');
  } else {
    backend = await makeFileBackend(primaries);
    console.log('Almacén de admins: archivo local (data/admins.json) — sin persistencia en Render free');
  }
  return backend;
}

export function adminStore() {
  if (!backend) throw new Error('El almacén de administradores no está inicializado.');
  return backend;
}
