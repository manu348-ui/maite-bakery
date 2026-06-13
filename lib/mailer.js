// Envío de emails vía SendGrid HTTP API (port 443).
// Render free bloquea SMTP, por eso no se usa nodemailer/Gmail directo.
// Configurar SENDGRID_API_KEY y MAIL_FROM (remitente verificado en SendGrid).
let config = null;

export function initMailer() {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.MAIL_FROM || process.env.GMAIL_USER || '';
  if (apiKey && from) {
    config = { apiKey, from };
    console.log('Mailer: SendGrid configurado (remitente ' + from + ')');
  } else {
    config = null;
    console.log('Mailer: deshabilitado (definí SENDGRID_API_KEY y MAIL_FROM para activar el envío).');
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
  if (!config || to.length === 0) {
    if (!config) console.log(`(Email deshabilitado) Pedido #${order.id} no notificado.`);
    return false;
  }
  try {
    const { html, text } = buildOrderEmail(order);
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: to.map((email) => ({ email })) }],
        from: { email: config.from, name: 'Maité Bakery' },
        subject: `Nuevo pedido #${order.id} — Maité Bakery`,
        content: [
          { type: 'text/plain', value: text },
          { type: 'text/html', value: html },
        ],
      }),
    });
    if (res.ok) {
      console.log(`Email de pedido #${order.id} enviado a: ${to.join(', ')}`);
      return true;
    }
    const detail = await res.text().catch(() => '');
    console.error(`Error SendGrid pedido #${order.id}: ${res.status} ${detail.slice(0, 300)}`);
    return false;
  } catch (err) {
    console.error(`Error enviando email del pedido #${order.id}:`, err.message);
    return false;
  }
}
