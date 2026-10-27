export async function handleAccounts(ctx) {
  const { service, method, path, readBody } = ctx

  if (method === "GET" && path === "/accounts") {
    return { body: { accounts: service.listAccounts() } }
  }

  if (method === "POST" && path === "/sync") {
    const body = await readBody()
    const results = body.accountId ? [await service.syncAccount(body.accountId)] : await service.syncAll()
    return { body: { results } }
  }

  return undefined
}
