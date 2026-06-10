# Maité Bakery

Sitio de la panadería (estático) con un backend mínimo en Node/Express que protege
el panel de administración con autenticación real.

## Páginas

| Archivo | Acceso | Descripción |
|---|---|---|
| `index.html` | público | Home / catálogo |
| `detalle.html` | público | Detalle de producto |
| `checkout.html` | público | Finalizar compra |
| `confirmacion.html` | público | Confirmación de pedido |
| `login.html` | público | Acceso de administrador (Google o contraseña) |
| `admin.html` | **protegido** | Panel de inventario y accesos |

## Requisitos

- Node.js 18+ (probado con 26)

## Puesta en marcha

```bash
npm install
cp .env.example .env      # en Windows PowerShell: Copy-Item .env.example .env
# Editá .env y completá SESSION_SECRET (obligatorio en prod)
npm start                 # http://localhost:3000
```

Para desarrollo con recarga automática: `npm run dev`.

## Variables de entorno

Ver `.env.example`. Las clave:

- **`SESSION_SECRET`** — secreto para firmar las cookies de sesión (JWT). Obligatorio
  en producción. Generalo con:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- **`GOOGLE_CLIENT_ID`** — debe coincidir con el del botón de Google en `login.html`.
- **`ADMIN_EMAILS`** — lista (separada por coma) de correos autorizados al panel.
- **`ADMIN_PASSWORD_HASH`** — hash bcrypt para el login por contraseña (opcional). Si
  se deja vacío, ese método queda deshabilitado. Generá el hash con:
  ```bash
  npm run hash -- "tu-contraseña"
  ```

## Cómo funciona la autenticación

- **Google:** `login.html` envía el `credential` al backend, que lo verifica con
  `google-auth-library` (firma + audiencia) y comprueba el email contra `ADMIN_EMAILS`.
  Nada se confía en el cliente.
- **Contraseña:** se compara contra `ADMIN_PASSWORD_HASH` con bcrypt en el servidor.
  El endpoint tiene rate limiting (10 intentos / 15 min por IP).
- En ambos casos se emite una cookie de sesión **httpOnly** firmada (JWT).
- `admin.html` se sirve sólo con sesión válida; sin ella, el servidor redirige a
  `login.html`. El botón de logout limpia la cookie.

## Despliegue (Render / Railway)

> GitHub Pages **no sirve** para este proyecto: solo aloja archivos estáticos y no
> ejecuta Node, así que el login y la protección del panel no funcionarían ahí. Hay
> que usar un host que corra Node. El repo de GitHub se mantiene como fuente.

### Render (recomendado)

1. Subí el repo a GitHub (incluyendo `package-lock.json`; **no** subas `.env`).
2. En Render: **New → Blueprint** y conectá el repo. Render lee `render.yaml`.
3. Cargá los secretos en el dashboard (Environment): `SESSION_SECRET` y, si usás
   contraseña, `ADMIN_PASSWORD_HASH`. El resto ya viene en `render.yaml`.
4. Deploy. Render expone HTTPS automáticamente.

### Railway (alternativa)

1. **New Project → Deploy from GitHub repo**. Railway detecta Node y usa `npm start`
   (o el `Procfile`).
2. En **Variables**, cargá: `NODE_ENV=production`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`,
   `ADMIN_EMAILS` y `ADMIN_PASSWORD_HASH` (si aplica).

### Conectar tu dominio

- En el host (Render/Railway) agregá tu dominio como *custom domain* y seguí sus
  instrucciones de DNS (un `CNAME`, normalmente).
- Si el dominio apuntaba a **GitHub Pages**, quitá esos registros DNS / el archivo
  `CNAME` del repo de Pages para que no haya conflicto.
- En **Google Cloud Console → Credentials → OAuth client → Authorized JavaScript
  origins**, asegurate de tener el dominio final (ej. `https://tudominio.com`).

## Checklist antes de producción

- [ ] Definir un `SESSION_SECRET` fuerte y único.
- [ ] Servir detrás de **HTTPS** (la cookie usa `secure` cuando `NODE_ENV=production`).
- [ ] En **Google Cloud Console → Credentials → OAuth client**, agregar el dominio de
      producción (y `http://localhost:3000` para pruebas) en *Authorized JavaScript
      origins*. Sin esto, el botón de Google da `403 / origin not allowed`.
- [ ] Configurar `ADMIN_EMAILS` con las cuentas reales.
- [ ] Si se usa contraseña, generar `ADMIN_PASSWORD_HASH` y no commitear el `.env`.
- [ ] (Opcional recomendado) Compilar Tailwind con el CLI en vez del CDN.

## Gestión de Accesos (administradores)

El panel permite al **administrador principal** autorizar/quitar correos que pueden
entrar con Google. La lista se guarda en PostgreSQL:

- En Render, `render.yaml` crea la base `maite-bakery-db` e inyecta `DATABASE_URL`
  automáticamente. Tras un push, hacé **Manual Sync** del Blueprint para que cree la DB.
- En local, si no hay `DATABASE_URL`, se usa `data/admins.json` (no persistente en prod).
- Los correos de `ADMIN_EMAILS` se siembran como `primary` (no se pueden borrar/desactivar).
- API (todo detrás de sesión; modificar requiere ser `primary`): `GET/POST/PATCH/DELETE /api/admins`.

## Inventario de panes

El panel permite a cualquier admin autenticado crear/editar/eliminar panes, persistidos
en la tabla `breads` de la misma base. API: `GET /api/breads` (pública) y
`POST/PUT/DELETE /api/breads` (requieren sesión). La tabla se crea y siembra sola en el
primer arranque. La imagen se guarda como URL (sin subida de archivos).

## Pendiente (opcional)

El **catálogo público** (`index.html`, `detalle.html`) todavía muestra panes fijos en el
HTML; podría leer de `GET /api/breads` para reflejar el inventario automáticamente.
