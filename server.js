import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

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

function isAllowedEmail(email) {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

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
    if (!isAllowedEmail(payload.email)) {
      return res.status(403).json({ error: `Acceso no autorizado para ${payload.email}.` });
    }
    issueSession(res, payload.email.toLowerCase());
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

app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, email: session.email });
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

app.listen(PORT, () => {
  console.log(`Maité Bakery escuchando en http://localhost:${PORT}`);
  console.log(`Admins autorizados: ${ADMIN_EMAILS.join(', ')}`);
  if (!ADMIN_PASSWORD_HASH) {
    console.log('Acceso por contraseña: deshabilitado (define ADMIN_PASSWORD_HASH para activarlo).');
  }
});
