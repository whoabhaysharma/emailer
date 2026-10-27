import { verifyUnsubscribe } from "../../unsubscribe.js"
import { escapeHtml } from "../respond.js"

export async function handlePublic(ctx) {
  const { path, method, service, version } = ctx

  if (path === "/health") {
    try {
      return { status: 200, body: { ok: true, version, ...service.health() } }
    } catch (error) {
      return { status: 500, body: { ok: false, error: String(error.message || error) } }
    }
  }

  // Public one-click unsubscribe. No bearer token: the signed token is the auth.
  const match = path.match(/^\/u\/([^/]+)$/)
  if (match && (method === "GET" || method === "POST")) {
    const secret = service.config().unsubscribeSecret
    const email = secret ? verifyUnsubscribe(secret, decodeURIComponent(match[1])) : null

    if (!email) {
      return { status: 400, html: "<h1>Invalid unsubscribe link</h1>" }
    }

    service.suppress([email], "unsubscribe")
    return {
      status: 200,
      html:
        `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>` +
        `<body style="font-family:system-ui;padding:40px;max-width:560px"><h1>Unsubscribed</h1>` +
        `<p>${escapeHtml(email)} has been removed from this list. ` +
        `You will not receive further marketing email.</p></body>`,
    }
  }

  return undefined
}
