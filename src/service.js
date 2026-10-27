import { loadConfig } from "./config.js"
import { createCampaigns } from "./domain/campaigns.js"
import { createContacts } from "./domain/contacts.js"
import { createEnrolments } from "./domain/enrolments.js"
import { createMessages } from "./domain/messages.js"
import { createMetrics } from "./domain/metrics.js"
import { createOutbound } from "./domain/outbound.js"
import { effectiveDailyLimit } from "./domain/shared.js"
import { createSync } from "./domain/sync.js"
import { createThreads } from "./domain/threads.js"

export { effectiveDailyLimit } from "./domain/shared.js"

/**
 * Composition root. Each domain module receives only the collaborators it needs,
 * which keeps the dependency graph acyclic and the modules individually testable.
 */
export function createService(store) {
  const config = () => loadConfig()

  const enrolments = createEnrolments({ store })
  const contacts = createContacts({ store, enrolments })
  const threads = createThreads({ store })
  const messages = createMessages({ store, contacts, threads, enrolments })
  const outbound = createOutbound({ store, config, contacts, threads })
  const campaigns = createCampaigns({ store, config, contacts, enrolments, outbound })
  const metrics = createMetrics({ store, config })
  const sync = createSync({ store, config, messages })

  return {
    store,
    config,
    ...enrolments,
    ...contacts,
    ...threads,
    ...messages,
    ...outbound,
    ...campaigns,
    ...metrics,
    ...sync,
    effectiveLimit: (account) => effectiveDailyLimit(account, config()),
  }
}
