import { createServer } from "node:http"
import { readJson, safeEqual, sendHtml, sendJson } from "./respond.js"
import { handleAccounts } from "./routes/accounts.js"
import { handleCampaigns } from "./routes/campaigns.js"
import { handleContacts } from "./routes/contacts.js"
import { handleMessages } from "./routes/messages.js"
import { handleOps } from "./routes/ops.js"
import { handlePublic } from "./routes/public.js"

const PROTECTED_ROUTES = [handleAccounts, handleMessages, handleContacts, handleCampaigns, handleOps]

function writeResult(res, result) {
  if (result.html !== undefined) return sendHtml(res, result.status ?? 200, result.html)
  return sendJson(res, result.status ?? 200, result.body ?? {})
}

export function createHttpServer({ service, token, version = "0.1.0", logger = console }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1")
    const path = url.pathname.replace(/\/+$/, "") || "/"
    const method = req.method || "GET"

    let bodyPromise
    const readBody = () => (bodyPromise ??= readJson(req))
    const ctx = { service, version, method, path, url, readBody }

    try {
      const publicResult = await handlePublic(ctx)
      if (publicResult) return writeResult(res, publicResult)

      if (!safeEqual(req.headers.authorization, `Bearer ${token}`)) {
        return sendJson(res, 401, { error: "Unauthorized" })
      }

      for (const route of PROTECTED_ROUTES) {
        const result = await route(ctx)
        if (result) return writeResult(res, result)
      }

      return sendJson(res, 404, { error: `No route for ${method} ${path}` })
    } catch (error) {
      const message = String(error.message || error)
      logger.error?.(`[email-agent] ${method} ${path}: ${message}`)
      return sendJson(res, /not found/i.test(message) ? 404 : 400, { error: message })
    }
  })

  server.requestTimeout = 30_000
  return server
}
