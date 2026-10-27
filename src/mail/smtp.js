import nodemailer from "nodemailer"

const cache = new Map()

export function transportFor(account, password) {
  const key = `${account.id}:${account.smtp?.host}:${account.smtp?.port}:${account.email}`
  const cached = cache.get(key)
  if (cached) return cached

  const smtp = account.smtp || {}
  const transport = nodemailer.createTransport({
    host: smtp.host || "smtp.gmail.com",
    port: Number(smtp.port || 465),
    secure: smtp.secure !== false,
    requireTLS: smtp.secure === false,
    auth: { user: account.email, pass: password },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  })
  cache.set(key, transport)
  return transport
}

export async function verifySmtp(account, password) {
  const transport = transportFor(account, password)
  await transport.verify()
  return true
}

export async function sendSmtp(account, password, mail) {
  const transport = transportFor(account, password)
  const info = await transport.sendMail({
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    replyTo: mail.replyTo,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    messageId: mail.messageId,
    headers: mail.headers,
  })
  return {
    messageId: info.messageId,
    response: info.response,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
  }
}

export function closeTransports() {
  for (const transport of cache.values()) {
    try {
      transport.close()
    } catch {}
  }
  cache.clear()
}
