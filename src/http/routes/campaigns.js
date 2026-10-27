export async function handleCampaigns(ctx) {
  const { service, method, path, readBody } = ctx

  if (method === "GET" && path === "/campaigns") {
    return { body: { campaigns: service.listCampaigns() } }
  }

  if (method === "POST" && path === "/campaigns") {
    return { body: service.createCampaign(await readBody()) }
  }

  if (method === "POST" && path === "/campaigns/pause-all") return { body: service.pauseAll() }
  if (method === "POST" && path === "/campaigns/resume-all") return { body: service.resumeAll() }

  const campaignMatch = path.match(/^\/campaigns\/([^/]+)$/)
  if (method === "GET" && campaignMatch) {
    return { body: service.getCampaign(decodeURIComponent(campaignMatch[1])) }
  }

  const actionMatch = path.match(/^\/campaigns\/([^/]+)\/(status|enrol|preview)$/)
  if (method === "POST" && actionMatch) {
    const id = decodeURIComponent(actionMatch[1])
    const action = actionMatch[2]
    const body = await readBody()

    if (action === "status") return { body: service.setCampaignStatus(id, body.status) }
    if (action === "preview") return { body: await service.previewCampaign(id, body) }
    return { body: service.enrolContacts({ campaignId: id, contacts: body.contacts }) }
  }

  return undefined
}
