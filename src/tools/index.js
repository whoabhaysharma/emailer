import { createCampaignTools } from "./campaigns.js"
import { createComposeTools } from "./compose.js"
import { createContactTools } from "./contacts.js"
import { createOpsTools } from "./ops.js"
import { createReadTools } from "./read.js"

export function createTools(client) {
  return [
    ...createReadTools(client),
    ...createComposeTools(client),
    ...createCampaignTools(client),
    ...createContactTools(client),
    ...createOpsTools(client),
  ]
}

export { createCampaignTools, createComposeTools, createContactTools, createOpsTools, createReadTools }
