export async function handleMessages(ctx) {
  const { service, method, path, url, readBody } = ctx

  if (method === "GET" && path === "/search") {
    const params = Object.fromEntries(url.searchParams.entries())
    return { body: { messages: service.searchMessages(params) } }
  }

  const threadMatch = path.match(/^\/threads\/([^/]+)$/)
  if (method === "GET" && threadMatch) {
    return { body: service.getThread(decodeURIComponent(threadMatch[1])) }
  }

  if (method === "POST" && path === "/drafts") {
    return { body: await service.createDraft(await readBody()) }
  }

  if (method === "GET" && path === "/drafts") {
    const status = url.searchParams.get("status") || "pending"
    return { body: { drafts: service.listDrafts(status, url.searchParams.get("limit") || 50) } }
  }

  if (method === "POST" && path === "/reply") {
    return { body: await service.replyToMessage(await readBody()) }
  }

  if (method === "POST" && path === "/send") {
    return { body: await service.send(await readBody()) }
  }

  return undefined
}
