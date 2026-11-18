import nodemailer from 'npm:nodemailer@6.10.1'

type EmailMessage = {
  to: string
  subject: string
  text?: string
  html?: string
  preheader?: string
}

export function escapeEmailHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

function brandedEmail(message: EmailMessage, brand: string) {
  const appUrl = Deno.env.get('APP_PUBLIC_URL')
  let logo = ''
  try {
    const url = appUrl ? new URL(appUrl) : null
    if (url?.protocol === 'https:') logo = `<img src="${url.origin}/campusync-logo.png" width="54" height="54" alt="" style="display:block;width:54px;height:54px;object-fit:contain;border:0">`
  } catch { /* A missing public URL only omits the remote logo. */ }
  const preheader = escapeEmailHtml(message.preheader ?? message.subject)
  const content = message.html ?? `<p style="margin:0;color:#334155;font-size:15px;line-height:1.7;white-space:pre-line">${escapeEmailHtml(message.text ?? '')}</p>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:0;background:#edf3f0;font-family:Arial,Helvetica,sans-serif;color:#16332a"><div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all">${preheader}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#edf3f0"><tr><td align="center" style="padding:28px 14px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #dce7e1;border-radius:18px;overflow:hidden"><tr><td style="height:6px;background:#11865d;font-size:0;line-height:0">&nbsp;</td></tr><tr><td style="padding:22px 28px 18px"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding-right:13px;vertical-align:middle">${logo}</td><td style="vertical-align:middle"><div style="font-size:21px;line-height:1.2;font-weight:700;letter-spacing:-.3px;color:#123d30">${escapeEmailHtml(brand)}</div><div style="margin-top:4px;font-size:12px;letter-spacing:.5px;color:#64756e">Valencia NHS portal</div></td></tr></table></td></tr><tr><td style="padding:8px 28px 30px">${content}</td></tr><tr><td style="padding:18px 28px;background:#f7faf8;border-top:1px solid #e6eee9"><p style="margin:0;color:#64756e;font-size:12px;line-height:1.6">This is an automated message from CampuSync. If you need help, contact your school administrator.</p>${appUrl ? `<p style="margin:9px 0 0;font-size:12px"><a href="${escapeEmailHtml(appUrl)}" style="color:#087a53;text-decoration:none">Open CampuSync</a></p>` : ''}</td></tr></table><p style="margin:14px 0 0;color:#87958e;font-size:11px;line-height:1.5">© ${new Date().getFullYear()} CampuSync · Valencia National High School</p></td></tr></table></body></html>`
}

/** Sends transactional mail through the configured Gmail SMTP app password. */
export async function sendSchoolEmail(message: EmailMessage) {
  const host = Deno.env.get('SMTP_HOST')
  const port = Number(Deno.env.get('SMTP_PORT') ?? '465')
  const username = Deno.env.get('SMTP_USERNAME')
  const password = Deno.env.get('SMTP_PASSWORD')
  const fromEmail = Deno.env.get('SMTP_FROM_EMAIL')
  const fromName = Deno.env.get('SMTP_FROM_NAME') ?? 'CampuSync'

  if (!host || !username || !password || !fromEmail || !Number.isInteger(port)) {
    throw new Error('SMTP email delivery is not configured.')
  }

  // Supabase Edge Functions block outbound port 587. Gmail supports implicit
  // TLS on 465, so configure SMTP_PORT=465 for hosted Edge Function delivery.
  if (port !== 465) throw new Error('Hosted SMTP delivery must use port 465.')

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: true,
    auth: { user: username, pass: password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })

  return await transporter.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: brandedEmail(message, fromName),
  })
}
