// Pool de PostgreSQL compartido. Devuelve null si no hay DATABASE_URL
// (en ese caso los stores usan su respaldo en archivo).
import pg from 'pg';

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

let pool = null;

export function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, ssl: sslFor(url), max: 8 });
  }
  return pool;
}
