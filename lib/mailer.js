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
  const deliveryLabels = { recogida: 'Retiro en el local', domicilio: 'Envío a domicilio' };
  const delivery = deliveryLabels[order.delivery_method] || order.delivery_method;
  const addressHtml = order.address ? `<p><strong>Dirección:</strong> ${escapeHtml(order.address)}</p>` : '';
  const paymentLabels = { transferencia: 'Transferencia bancaria', efectivo: 'Efectivo' };
  const payment = paymentLabels[order.payment_method] || order.payment_method || '—';
  const paymentNote = order.payment_method === 'transferencia'
    ? ' <em>(coordiná por WhatsApp el alias y el comprobante)</em>'
    : order.payment_method === 'efectivo'
      ? ' <em>(paga al recibir/retirar)</em>'
      : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1b1c1c">
      <h2 style="color:#322214">Nuevo pedido #${order.id}</h2>
      <p><strong>Cliente:</strong> ${escapeHtml(order.customer_name)}</p>
      <p><strong>Teléfono:</strong> ${escapeHtml(order.phone)} ${waLink ? `· <a href="${waLink}">Abrir WhatsApp</a>` : ''}</p>
      <p><strong>Entrega:</strong> ${escapeHtml(delivery)}</p>${addressHtml}
      <p><strong>Pago:</strong> ${escapeHtml(payment)}${paymentNote}</p>
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
Entrega: ${delivery}${order.address ? '\nDirección: ' + order.address : ''}
Pago: ${payment}
Ítems:
${(order.items || []).map((it) => `  - ${it.name} x${it.qty} = ${fmt(it.price * it.qty)}`).join('\n')}
Subtotal: ${fmt(order.subtotal)} | Impuestos: ${fmt(order.tax)} | Total: ${fmt(order.total)}`;

  return { html, text };
}

export function mailerEnabled() {
  return !!config;
}

// Llamada de bajo nivel a SendGrid. Lanza si la API responde error.
async function sgSend(toList, subject, html, text) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: toList.map((email) => ({ email })) }],
      from: { email: config.from, name: 'Maité Bakery' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(res.status + ' ' + detail.slice(0, 300));
  }
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
    await sgSend(to, `Nuevo pedido #${order.id} — Maité Bakery`, html, text);
    console.log(`Email de pedido #${order.id} enviado a: ${to.join(', ')}`);
    return true;
  } catch (err) {
    console.error(`Error enviando email del pedido #${order.id}:`, err.message);
    return false;
  }
}

function buildCampaignEmail({ message, products, unsubscribeUrl, siteUrl }) {
  const msgHtml = escapeHtml(message).replace(/\n/g, '<br>');
  const cards = (products || []).map((p) => {
    const img = p.image_url
      ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" width="120" height="120" style="width:120px;height:120px;object-fit:cover;border-radius:6px;display:block">`
      : '';
    return `<td style="padding:8px;vertical-align:top;text-align:center">${img}<div style="font-weight:bold;color:#322214;margin-top:6px">${escapeHtml(p.name)}</div><div style="color:#725b27">$${Number(p.price).toFixed(2)}</div></td>`;
  }).join('');
  const productsHtml = cards
    ? `<table style="margin:16px 0;border-collapse:collapse"><tr>${cards}</tr></table>`
    : '';
  const cta = siteUrl
    ? `<p style="margin:18px 0"><a href="${escapeHtml(siteUrl)}" style="background:#4a3728;color:#fff;text-decoration:none;padding:10px 20px;border-radius:4px;display:inline-block">Ver la tienda</a></p>`
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#1b1c1c">
      <h2 style="color:#322214">Maité Bakery</h2>
      <div style="font-size:15px;line-height:1.6">${msgHtml}</div>
      ${productsHtml}
      ${cta}
      <hr style="border:none;border-top:1px solid #e4e2e1;margin:22px 0">
      <p style="color:#80756d;font-size:12px;line-height:1.5">
        Recibís este correo porque te suscribiste en Maité Bakery.<br>
        Si no querés recibir más, <a href="${escapeHtml(unsubscribeUrl)}" style="color:#80756d">cancelá tu suscripción acá</a>.
      </p>
    </div>`;

  const text = `${message}\n\n${siteUrl ? 'Tienda: ' + siteUrl + '\n\n' : ''}Recibís este correo porque te suscribiste en Maité Bakery.\nPara dejar de recibirlos: ${unsubscribeUrl}`;
  return { html, text };
}

// Envía un email de campaña a UN destinatario (envío individual por privacidad).
export async function sendCampaignEmail({ to, subject, message, products, unsubscribeUrl, siteUrl }) {
  if (!config) return false;
  try {
    const { html, text } = buildCampaignEmail({ message, products, unsubscribeUrl, siteUrl });
    await sgSend([to], subject, html, text);
    return true;
  } catch (err) {
    console.error('Error enviando campaña a ' + to + ':', err.message);
    return false;
  }
}
