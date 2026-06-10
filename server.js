import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { initAdminStore, adminStore, isValidEmail } from './lib/adminStore.js';
import { initBreadStore, breadStore, BREAD_STATUSES } from './lib/breadStore.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  '458018892518-srtasi2s4u8d3av95uj3val41nvtcf6a.apps.googleusercontent.com';

// Allowlist of emails permitted to reach the admin panel.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'manu348@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// Optional bcrypt hash for the password login. If unset, password login is disabled.
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

const SESSION_COOKIE = 'mb_session';
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 8);

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (IS_PROD) {
    console.error('FATAL: SESSION_SECRET no está definido. Configúralo antes de producción.');
    process.exit(1);
  }
  SESSION_SECRET = 'dev-only-insecure-secret-change-me';
  console.warn('⚠  Usando SESSION_SECRET de desarrollo. NO usar en producción.');
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

function issueSession(res, email) {
  const token = jwt.sign({ email }, SESSION_SECRET, {
    expiresIn: `${SESSION_TTL_HOURS}h`,
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: SESSION_TTL_HOURS * 60 * 60 * 1000,
    path: '/',
  });
}

function getSession(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, SESSION_SECRET);
  } catch {
    return null;
  }
}

function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// Guard for protected HTML pages: redirect to login when not authenticated.
function requireAuthPage(req, res, next) {
  if (getSession(req)) return next();
  return res.redirect('/login.html');
}

// Guard for API endpoints: 401 when not authenticated.
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'No autenticado.' });
  req.session = session;
  next();
}

// Only a primary admin may manage the access list.
async function requirePrimary(req, res, next) {
  try {
    const me = await adminStore().get((req.session?.email || '').toLowerCase());
    if (me && me.role === 'primary') return next();
    return res.status(403).json({ error: 'Solo el administrador principal puede gestionar accesos.' });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Very small in-memory rate limiter for the password endpoint
// ---------------------------------------------------------------------------
const attempts = new Map(); // ip -> { count, resetAt }
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX = 10;

function rateLimitPassword(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    return next();
  }
  if (entry.count >= RL_MAX) {
    return res.status(429).json({ error: 'Demasiados intentos. Inténtalo más tarde.' });
  }
  entry.count += 1;
  next();
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Falta el credential.' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email_verified) {
      return res.status(403).json({ error: 'El correo de Google no está verificado.' });
    }
    const email = payload.email.toLowerCase();
    if (!(await adminStore().isAllowed(email))) {
      return res.status(403).json({ error: `Acceso no autorizado para ${payload.email}.` });
    }
    issueSession(res, email);
    return res.json({ ok: true, email: payload.email });
  } catch (err) {
    console.error('Error verificando token de Google:', err.message);
    return res.status(401).json({ error: 'Token de Google inválido.' });
  }
});

app.post('/api/auth/password', rateLimitPassword, async (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD_HASH) {
    return res.status(503).json({ error: 'El acceso por contraseña no está habilitado.' });
  }
  if (!password) return res.status(400).json({ error: 'Falta la contraseña.' });

  const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta.' });

  // The password grants access as the primary admin (first allowlisted email).
  issueSession(res, ADMIN_EMAILS[0] || 'admin');
  return res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  let role = 'admin';
  try {
    const me = await adminStore().get((session.email || '').toLowerCase());
    if (me) role = me.role;
  } catch {
    /* store not ready — default role */
  }
  res.json({ authenticated: true, email: session.email, role });
});

// ---------------------------------------------------------------------------
// Access management API (admin allowlist)
// ---------------------------------------------------------------------------
app.get('/api/admins', requireAuth, async (req, res) => {
  res.json(await adminStore().list());
});

app.post('/api/admins', requireAuth, requirePrimary, async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Correo electrónico inválido.' });
  await adminStore().add(email);
  res.json({ ok: true, list: await adminStore().list() });
});

app.patch('/api/admins/:email', requireAuth, requirePrimary, async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const active = !!req.body?.active;
  const ok = await adminStore().setActive(email, active);
  if (!ok) return res.status(400).json({ error: 'No se pudo actualizar (el principal no se puede desactivar).' });
  res.json({ ok: true, list: await adminStore().list() });
});

app.delete('/api/admins/:email', requireAuth, requirePrimary, async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const ok = await adminStore().remove(email);
  if (!ok) return res.status(400).json({ error: 'No se pudo eliminar (el administrador principal no se puede borrar).' });
  res.json({ ok: true, list: await adminStore().list() });
});

// ---------------------------------------------------------------------------
// Inventory API (breads)
// ---------------------------------------------------------------------------
function parseBread(body) {
  const name = String(body?.name || '').trim();
  const price = Number(body?.price);
  if (!name) return { error: 'El nombre es obligatorio.' };
  if (!Number.isFinite(price) || price < 0) return { error: 'El precio debe ser un número válido.' };
  const status = BREAD_STATUSES.includes(body?.status) ? body.status : 'in_stock';
  return {
    data: {
      name,
      description: String(body?.description || '').trim(),
      price,
      status,
      image_url: String(body?.image_url || '').trim(),
    },
  };
}

// Lista pública (sirve para el panel y, a futuro, para el catálogo).
app.get('/api/breads', async (req, res) => {
  res.json(await breadStore().list());
});

app.post('/api/breads', requireAuth, async (req, res) => {
  const { data, error } = parseBread(req.body);
  if (error) return res.status(400).json({ error });
  const bread = await breadStore().add(data);
  res.json({ ok: true, bread });
});

app.put('/api/breads/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
  const { data, error } = parseBread(req.body);
  if (error) return res.status(400).json({ error });
  const bread = await breadStore().update(id, data);
  if (!bread) return res.status(404).json({ error: 'Pan no encontrado.' });
  res.json({ ok: true, bread });
});

app.delete('/api/breads/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
  const ok = await breadStore().remove(id);
  if (!ok) return res.status(404).json({ error: 'Pan no encontrado.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Protected page(s) — must be registered BEFORE the static middleware
// ---------------------------------------------------------------------------
app.get(['/admin', '/admin.html'], requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ---------------------------------------------------------------------------
// Block sensitive files from being served as static assets
// ---------------------------------------------------------------------------
const BLOCKED = [
  /^\/server\.js$/i,
  /^\/package(-lock)?\.json$/i,
  /^\/\.env/i,
  /^\/node_modules(\/|$)/i,
  /^\/memory(\/|$)/i,
  /^\/outbound\.txt$/i,
];
app.use((req, res, next) => {
  if (BLOCKED.some((re) => re.test(req.path))) {
    return res.status(404).send('Not found');
  }
  next();
});

// Public static assets (index, detalle, login, checkout, confirmacion, ...)
app.use(
  express.static(__dirname, {
    extensions: ['html'],
    dotfiles: 'deny',
    index: 'index.html',
  })
);

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
  await initAdminStore({
    databaseUrl: process.env.DATABASE_URL,
    primaryEmails: ADMIN_EMAILS,
  });
  await initBreadStore({ databaseUrl: process.env.DATABASE_URL });

  app.listen(PORT, () => {
    console.log(`Maité Bakery escuchando en http://localhost:${PORT}`);
    console.log(`Administrador(es) principal(es): ${ADMIN_EMAILS.join(', ')}`);
    if (!ADMIN_PASSWORD_HASH) {
      console.log('Acceso por contraseña: deshabilitado (define ADMIN_PASSWORD_HASH para activarlo).');
    }
  });
}

start().catch((err) => {
  console.error('FATAL: no se pudo iniciar el servidor:', err.message);
  process.exit(1);
});
