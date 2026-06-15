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
import { initOrderStore, orderStore, ORDER_STATUSES } from './lib/orderStore.js';
import { initSettingsStore, settingsStore } from './lib/settingsStore.js';
import { initSubscriberStore, subscriberStore } from './lib/subscriberStore.js';
import { initMailer, sendOrderNotification, sendCampaignEmail, mailerEnabled } from './lib/mailer.js';

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

// URL pública del sitio (para armar el link de baja en las campañas).
const SITE_URL = (process.env.SITE_URL || 'https://maite-bakery.onrender.com').replace(/\/$/, '');

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
app.use(express.json({ limit: '4mb' })); // 4mb: deja margen para fotos en data URL
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

function makeRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    const e = hits.get(ip);
    if (!e || now > e.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (e.count >= max) return res.status(429).json({ error: message });
    e.count += 1;
    next();
  };
}
const rateLimitSubscribe = makeRateLimiter({ windowMs: 10 * 60 * 1000, max: 6, message: 'Demasiadas suscripciones desde esta conexión. Probá más tarde.' });
const rateLimitCampaign = makeRateLimiter({ windowMs: 60 * 60 * 1000, max: 12, message: 'Demasiados envíos seguidos. Esperá un rato.' });

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

// Lista pública (la usa el panel y el catálogo).
app.get('/api/breads', async (req, res) => {
  res.json(await breadStore().list());
});

// Un pan individual (público, para la página de detalle).
app.get('/api/breads/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
  const bread = await breadStore().get(id);
  if (!bread) return res.status(404).json({ error: 'Pan no encontrado.' });
  res.json(bread);
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
// Orders API
// ---------------------------------------------------------------------------
const TAX_RATE = 0.10;

// Crear un pedido (público, desde el checkout). Los totales se recalculan en el
// servidor a partir de los precios reales de la base (no se confía en el cliente).
app.post('/api/orders', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const delivery = String(req.body?.delivery || 'recogida').trim() || 'recogida';
  const address = String(req.body?.address || '').trim();
  const payment = String(req.body?.payment || '').trim();
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!name) return res.status(400).json({ error: 'Falta el nombre del cliente.' });
  if (!phone) return res.status(400).json({ error: 'Falta el teléfono.' });
  if (delivery === 'domicilio' && !address) return res.status(400).json({ error: 'Falta la dirección de envío.' });
  if (!['transferencia', 'efectivo'].includes(payment)) return res.status(400).json({ error: 'Elegí un medio de pago.' });
  if (rawItems.length === 0) return res.status(400).json({ error: 'El carrito está vacío.' });

  // Resolver cada ítem contra la base.
  const items = [];
  let subtotal = 0;
  for (const it of rawItems) {
    const bread = await breadStore().get(Number(it.id));
    const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
    if (!bread) return res.status(400).json({ error: 'Hay un producto que ya no existe.' });
    subtotal += bread.price * qty;
    items.push({ id: bread.id, name: bread.name, price: bread.price, qty });
  }
  subtotal = Math.round(subtotal * 100) / 100;
  const tax = Math.round(subtotal * TAX_RATE * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;

  const order = await orderStore().add({
    customer_name: name,
    phone,
    delivery_method: delivery,
    address,
    payment_method: payment,
    items,
    subtotal,
    tax,
    total,
  });

  // Notificar por email sin bloquear la respuesta.
  settingsStore()
    .get('notification_emails', ADMIN_EMAILS[0] || '')
    .then((csv) => sendOrderNotification(order, csv.split(',').map((e) => e.trim()).filter(Boolean)))
    .catch((e) => console.error('Notificación de pedido falló:', e.message));

  res.json({ ok: true, orderId: order.id });
});

app.get('/api/orders', requireAuth, async (req, res) => {
  res.json(await orderStore().list());
});

app.patch('/api/orders/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
  const ok = await orderStore().setStatus(id, status);
  if (!ok) return res.status(404).json({ error: 'Pedido no encontrado.' });
  res.json({ ok: true });
});

app.delete('/api/orders/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
  const ok = await orderStore().remove(id);
  if (!ok) return res.status(404).json({ error: 'Pedido no encontrado.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Settings API — destinatarios de notificación de pedidos
// ---------------------------------------------------------------------------
app.get('/api/settings/notifications', requireAuth, async (req, res) => {
  const csv = await settingsStore().get('notification_emails', ADMIN_EMAILS[0] || '');
  res.json({ emails: csv });
});

app.put('/api/settings/notifications', requireAuth, requirePrimary, async (req, res) => {
  const raw = String(req.body?.emails || '');
  const list = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return res.status(400).json({ error: 'Indicá al menos un correo.' });
  const invalid = list.find((e) => !isValidEmail(e));
  if (invalid) return res.status(400).json({ error: `Correo inválido: ${invalid}` });
  await settingsStore().set('notification_emails', list.join(', '));
  res.json({ ok: true, emails: list.join(', ') });
});

// ---------------------------------------------------------------------------
// Suscriptores y campañas de email
// ---------------------------------------------------------------------------
const CAMPAIGN_MAX_RECIPIENTS = 200;

// Alta de suscriptor (público, desde el formulario del home). Opt-in.
app.post('/api/subscribe', rateLimitSubscribe, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Correo inválido.' });
  await subscriberStore().add(email);
  res.json({ ok: true });
});

app.get('/api/subscribers', requireAuth, async (req, res) => {
  res.json(await subscriberStore().list());
});

app.delete('/api/subscribers/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
  const ok = await subscriberStore().remove(id);
  if (!ok) return res.status(404).json({ error: 'Suscriptor no encontrado.' });
  res.json({ ok: true });
});

// Enviar campaña — solo admin principal. Anti-spam: solo a suscriptores activos,
// envío individual (sin exponer la lista) y con link de baja por destinatario.
app.post('/api/campaigns', requireAuth, requirePrimary, rateLimitCampaign, async (req, res) => {
  if (!mailerEnabled()) return res.status(503).json({ error: 'El envío de email no está configurado (falta SENDGRID_API_KEY).' });

  const subject = String(req.body?.subject || '').trim();
  const message = String(req.body?.message || '').trim();
  const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
  const emails = Array.isArray(req.body?.emails)
    ? [...new Set(req.body.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))]
    : [];

  if (!subject) return res.status(400).json({ error: 'Falta el asunto.' });
  if (!message) return res.status(400).json({ error: 'Falta el mensaje.' });
  if (emails.length === 0) return res.status(400).json({ error: 'Seleccioná al menos un destinatario.' });

  // Filtrar: solo suscriptores activos (no dados de baja).
  const valid = [];
  for (const e of emails) {
    if (await subscriberStore().isActive(e)) valid.push(e);
  }
  if (valid.length === 0) return res.status(400).json({ error: 'Ninguno de los seleccionados es un suscriptor activo.' });
  if (valid.length > CAMPAIGN_MAX_RECIPIENTS) {
    return res.status(400).json({ error: `Máximo ${CAMPAIGN_MAX_RECIPIENTS} destinatarios por envío.` });
  }

  // Productos a destacar (opcional).
  const products = [];
  for (const id of productIds) {
    const b = await breadStore().get(Number(id));
    if (b) products.push({ name: b.name, price: b.price, image_url: b.image_url });
  }

  let sent = 0;
  let failed = 0;
  for (const email of valid) {
    const token = jwt.sign({ sub: email, p: 'unsub' }, SESSION_SECRET);
    const unsubscribeUrl = `${SITE_URL}/unsubscribe?token=${encodeURIComponent(token)}`;
    const ok = await sendCampaignEmail({ to: email, subject, message, products, unsubscribeUrl, siteUrl: SITE_URL });
    if (ok) sent += 1;
    else failed += 1;
  }
  res.json({ ok: true, sent, failed, total: valid.length });
});

// Baja de suscripción (público, desde el link del email).
function unsubPage(msg) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Maité Bakery</title></head>
  <body style="font-family:Arial,sans-serif;background:#fbf9f8;color:#1b1c1c;display:flex;min-height:90vh;align-items:center;justify-content:center;text-align:center;padding:24px">
  <div><h1 style="color:#322214;font-size:22px">Maité Bakery</h1><p style="font-size:16px;color:#4e453e">${msg}</p>
  <p style="margin-top:18px"><a href="${SITE_URL}" style="color:#725b27">Volver a la tienda</a></p></div></body></html>`;
}

app.get('/unsubscribe', async (req, res) => {
  const token = String(req.query.token || '');
  let email = null;
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    if (payload.p === 'unsub') email = payload.sub;
  } catch {
    /* token inválido */
  }
  if (!email) return res.status(400).send(unsubPage('El enlace de baja no es válido o ya no está disponible.'));
  await subscriberStore().unsubscribe(email);
  res.send(unsubPage('Listo, te diste de baja. No vas a recibir más correos de Maité Bakery.'));
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
  await initOrderStore({ databaseUrl: process.env.DATABASE_URL });
  await initSettingsStore({
    databaseUrl: process.env.DATABASE_URL,
    seed: { notification_emails: ADMIN_EMAILS[0] || '' },
  });
  await initSubscriberStore({ databaseUrl: process.env.DATABASE_URL });
  initMailer();

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
