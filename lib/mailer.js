// Envío de emails con Gmail (nodemailer + contraseña de aplicación).
// Configurar GMAIL_USER y GMAIL_APP_PASSWORD. Si faltan, no envía (solo loguea).
import nodemailer from 'nodemailer';

let transporter = null;

export function initMailer() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (user && pass) {
    transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
    console.log('Mailer: Gmail configurado (' + user + ')');
  } else {
    transporter = null;
    console.log('Mailer: deshabilitado (definí GMAIL_USER y GMAIL_APP_PASSWORD para activar el envío).');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildOrderEmail(order) {
  const fmt = (n) => '$' + Number(n).toFixed(2);
  const rows = (order.items || [])
    .map((it) => `<tr><td style="padding:4px 8px">${escapeHtml(it.name)}</td><td style="padding:4px 8px;text-align:center">x${it.qty}</td><td style="padding:4px 8px;text-align:right">${fmt(it.price * it.qty)}</td></tr>`)
    .join('');
  const waDigits = String(order.phone || '').replace(/\D/g, '');
  const waLink = waDigits ? `https://wa.me/${waDigits}` : '';
  const delivery = order.delivery_method === 'recogida' ? 'Recogida en tienda' : order.delivery_method;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1b1c1c">
      <h2 style="color:#322214">Nuevo pedido #${order.id}</h2>
      <p><strong>Cliente:</strong> ${escapeHtml(order.customer_name)}</p>
      <p><strong>Teléfono:</strong> ${escapeHtml(order.phone)} ${waLink ? `· <a href="${waLink}">Abrir WhatsApp</a>` : ''}</p>
      <p><strong>Entrega:</strong> ${escapeHtml(delivery)}</p>
      <table style="border-collapse:collapse;width:100%;margin-top:12px">
        <thead><tr style="border-bottom:1px solid #d2c4bb"><th style="text-align:left;padding:4px 8px">Producto</th><th style="padding:4px 8px">Cant.</th><th style="text-align:right;padding:4px 8px">Importe</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="text-align:right;margin-top:8px">Subtotal: ${fmt(order.subtotal)}<br>Impuestos: ${fmt(order.tax)}<br><strong>Total: ${fmt(order.total)}</strong></p>
      <p style="color:#80756d;font-size:12px">Maité Bakery · pedido recibido el ${new Date(order.created_at).toLocaleString('es-AR')}</p>
    </div>`;

  const text = `Nuevo pedido #${order.id}
Cliente: ${order.customer_name}
Teléfono: ${order.phone}${waLink ? ' (' + waLink + ')' : ''}
Entrega: ${delivery}
Ítems:
${(order.items || []).map((it) => `  - ${it.name} x${it.qty} = ${fmt(it.price * it.qty)}`).join('\n')}
Subtotal: ${fmt(order.subtotal)} | Impuestos: ${fmt(order.tax)} | Total: ${fmt(order.total)}`;

  return { html, text };
}

// Envía la notificación de un pedido. No lanza: si falla, loguea y sigue.
export async function sendOrderNotification(order, recipients) {
  const to = (recipients || []).filter(Boolean);
  if (!transporter || to.length === 0) {
    if (!transporter) console.log(`(Email deshabilitado) Pedido #${order.id} no notificado.`);
    return false;
  }
  try {
    const { html, text } = buildOrderEmail(order);
    await transporter.sendMail({
      from: `Maité Bakery <${process.env.GMAIL_USER}>`,
      to: to.join(', '),
      subject: `Nuevo pedido #${order.id} — Maité Bakery`,
      text,
      html,
    });
    console.log(`Email de pedido #${order.id} enviado a: ${to.join(', ')}`);
    return true;
  } catch (err) {
    console.error(`Error enviando email del pedido #${order.id}:`, err.message);
    return false;
  }
}
