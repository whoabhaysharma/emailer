export async function handleOps(ctx) {
  const { service, method, path, url, readBody } = ctx

  if (method === "GET" && path === "/stats") return { body: service.stats() }

  if (method === "GET" && path === "/unclassified") {
    return { body: { messages: service.unclassified(url.searchParams.get("limit") || 20) } }
  }

  if (method === "POST" && path === "/classify") {
    return { body: service.classifyMessage(await readBody()) }
  }

  if (method === "POST" && path === "/tick") {
    return { body: await service.tickCampaigns() }
  }

  if (method === "POST" && path === "/reclassify") {
    return { body: service.reclassify(await readBody()) }
  }

  return undefined
}
