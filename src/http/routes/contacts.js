export async function handleContacts(ctx) {
  const { service, method, path, url, readBody } = ctx

  if (method === "GET" && path === "/contacts") {
    const contacts = service.listContacts({
      query: url.searchParams.get("query") || undefined,
      status: url.searchParams.get("status") || undefined,
      limit: url.searchParams.get("limit") || 100,
    })
    return { body: { contacts } }
  }

  if (method === "POST" && path === "/contacts/import") {
    return { body: service.importContacts(await readBody()) }
  }

  if (method === "POST" && path === "/contacts/status") {
    const body = await readBody()
    return { body: service.setContactStatus(body.email, body.status, body.notBefore) }
  }

  const contactMatch = path.match(/^\/contacts\/([^/]+)$/)
  if (method === "GET" && contactMatch) {
    const email = decodeURIComponent(contactMatch[1])
    const contact = service.getContact(email)
    if (!contact) return { status: 404, body: { error: `Contact not found: ${email}` } }
    return { body: { contact, messages: service.searchMessages({ from: email, limit: 50 }) } }
  }

  if (method === "POST" && path === "/suppress") {
    const body = await readBody()
    return { body: service.suppress(body.emails, body.reason || "manual") }
  }

  if (method === "GET" && path === "/suppressions") {
    return { body: { suppressions: service.listSuppressions() } }
  }

  return undefined
}
