import { createServer } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { verifyUnsubscribe } from "./unsubscribe.js"

const MAX_BODY = 2 * 1024 * 1024

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""))
  const right = Buffer.from(String(b || ""))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error("Request body too large")
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString("utf8")
  try {
    return JSON.parse(text)
  } catch {
    throw new Error("Invalid JSON body")
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

export function createHttpServer({ service, token, version = "0.1.0", logger = console }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1")
    const path = url.pathname.replace(/\/+$/, "") || "/"

    if (path === "/health") {
      try {
        return sendJson(res, 200, { ok: true, version, ...service.health() })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) })
      }
    }

    // Public one-click unsubscribe. No bearer token: the signed token is the auth.
    const unsubscribeMatch = path.match(/^\/u\/([^/]+)$/)
    if (unsubscribeMatch && (req.method === "GET" || req.method === "POST")) {
      const secret = service.config().unsubscribeSecret
      const email = secret ? verifyUnsubscribe(secret, decodeURIComponent(unsubscribeMatch[1])) : null
      if (!email) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
        return res.end("<h1>Invalid unsubscribe link</h1>")
      }
      service.suppress([email], "unsubscribe")
      const safe = String(email).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(
        `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><body style="font-family:system-ui;padding:40px;max-width:560px"><h1>Unsubscribed</h1><p>${safe} has been removed from this list. You will not receive further marketing email.</p></body>`,
      )
    }

    if (!safeEqual(req.headers.authorization, `Bearer ${token}`)) {
      return sendJson(res, 401, { error: "Unauthorized" })
    }

    try {
      const method = req.method || "GET"

      if (method === "GET" && path === "/accounts") return sendJson(res, 200, { accounts: service.listAccounts() })

      if (method === "POST" && path === "/sync") {
        const body = await readJson(req)
        const results = body.accountId ? [await service.syncAccount(body.accountId)] : await service.syncAll()
        return sendJson(res, 200, { results })
      }

      if (method === "GET" && path === "/search") {
        const params = Object.fromEntries(url.searchParams.entries())
        return sendJson(res, 200, { messages: service.searchMessages(params) })
      }

      const threadMatch = path.match(/^\/threads\/([^/]+)$/)
      if (method === "GET" && threadMatch) {
        return sendJson(res, 200, service.getThread(decodeURIComponent(threadMatch[1])))
      }

      const contactMatch = path.match(/^\/contacts\/([^/]+)$/)
      if (method === "GET" && contactMatch) {
        const email = decodeURIComponent(contactMatch[1])
        const contact = service.getContact(email)
        if (!contact) return sendJson(res, 404, { error: `Contact not found: ${email}` })
        const messages = service.searchMessages({ from: email, limit: 50 })
        return sendJson(res, 200, { contact, messages })
      }

      if (method === "GET" && path === "/contacts") {
        const contacts = service.listContacts({
          query: url.searchParams.get("query") || undefined,
          status: url.searchParams.get("status") || undefined,
          limit: url.searchParams.get("limit") || 100,
        })
        return sendJson(res, 200, { contacts })
      }

      if (method === "POST" && path === "/contacts/import") {
        const body = await readJson(req)
        return sendJson(res, 200, service.importContacts(body))
      }

      if (method === "POST" && path === "/contacts/status") {
        const body = await readJson(req)
        return sendJson(res, 200, service.setContactStatus(body.email, body.status, body.notBefore))
      }

      if (method === "POST" && path === "/drafts") {
        const body = await readJson(req)
        return sendJson(res, 200, await service.createDraft(body))
      }

      if (method === "POST" && path === "/send") {
        const body = await readJson(req)
        return sendJson(res, 200, await service.send(body))
      }

      if (method === "GET" && path === "/drafts") {
        const status = url.searchParams.get("status") || "pending"
        return sendJson(res, 200, { drafts: service.listDrafts(status, url.searchParams.get("limit") || 50) })
      }

      if (method === "POST" && path === "/reply") {
        const body = await readJson(req)
        return sendJson(res, 200, await service.replyToMessage(body))
      }

      if (method === "GET" && path === "/campaigns") return sendJson(res, 200, { campaigns: service.listCampaigns() })

      if (method === "POST" && path === "/campaigns") {
        const body = await readJson(req)
        return sendJson(res, 200, service.createCampaign(body))
      }

      const campaignMatch = path.match(/^\/campaigns\/([^/]+)$/)
      if (method === "GET" && campaignMatch) {
        return sendJson(res, 200, service.getCampaign(decodeURIComponent(campaignMatch[1])))
      }

      const campaignActionMatch = path.match(/^\/campaigns\/([^/]+)\/(status|enrol|preview)$/)
      if (method === "POST" && campaignActionMatch) {
        const id = decodeURIComponent(campaignActionMatch[1])
        const action = campaignActionMatch[2]
        const body = await readJson(req)
        if (action === "status") return sendJson(res, 200, service.setCampaignStatus(id, body.status))
        if (action === "preview") return sendJson(res, 200, await service.previewCampaign(id, body))
        return sendJson(res, 200, service.enrolContacts({ campaignId: id, contacts: body.contacts }))
      }

      if (method === "POST" && path === "/campaigns/pause-all") return sendJson(res, 200, service.pauseAll())
      if (method === "POST" && path === "/campaigns/resume-all") return sendJson(res, 200, service.resumeAll())

      if (method === "POST" && path === "/suppress") {
        const body = await readJson(req)
        return sendJson(res, 200, service.suppress(body.emails, body.reason || "manual"))
      }

      if (method === "GET" && path === "/suppressions") return sendJson(res, 200, { suppressions: service.listSuppressions() })

      if (method === "GET" && path === "/stats") return sendJson(res, 200, service.stats())

      if (method === "GET" && path === "/unclassified") {
        return sendJson(res, 200, { messages: service.unclassified(url.searchParams.get("limit") || 20) })
      }

      if (method === "POST" && path === "/classify") {
        const body = await readJson(req)
        return sendJson(res, 200, service.classifyMessage(body))
      }

      if (method === "POST" && path === "/tick") {
        return sendJson(res, 200, await service.tickCampaigns())
      }

      return sendJson(res, 404, { error: `No route for ${method} ${path}` })
    } catch (error) {
      const message = String(error.message || error)
      logger.error?.(`[email-agent] ${req.method} ${path}: ${message}`)
      return sendJson(res, /not found/i.test(message) ? 404 : 400, { error: message })
    }
  })

  server.requestTimeout = 30_000
  return server
}
