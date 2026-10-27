import { randomUUID } from "node:crypto"
import { getAccount } from "../config.js"
import { isEmail, normalizeEmail } from "../mail/address.js"
import { render } from "../mail/mime.js"
import { clamp, contactVars, inBusinessWindow, nowIso, parseRefs } from "./shared.js"

export function createCampaigns({ store, config, contacts, enrolments, outbound }) {
  function campaignStats(campaignId) {
    const states = Object.fromEntries(
      store
        .all("SELECT state, COUNT(*) AS count FROM enrolments WHERE campaign_id = ? GROUP BY state", campaignId)
        .map((row) => [row.state, Number(row.count)]),
    )

    const steps = store
      .all("SELECT position, subject, delay_days FROM campaign_steps WHERE campaign_id = ? ORDER BY position ASC", campaignId)
      .map((step) => {
        const sent = Number(
          store.get(
            "SELECT COUNT(*) AS count FROM messages WHERE campaign_id = ? AND step = ? AND status IN ('sent','simulated','preview')",
            campaignId,
            step.position,
          )?.count || 0,
        )
        const replies = Number(
          store.get(
            `SELECT COUNT(DISTINCT r.from_addr) AS count
             FROM messages r JOIN messages o ON o.thread_id = r.thread_id
             WHERE r.direction = 'in' AND o.campaign_id = ? AND o.step = ?`,
            campaignId,
            step.position,
          )?.count || 0,
        )
        return { position: step.position, subject: step.subject, delayDays: step.delay_days, sent, replies }
      })

    return { ...states, steps }
  }

  function listCampaigns() {
    return store.all("SELECT * FROM campaigns ORDER BY created_at DESC").map((campaign) => ({
      ...campaign,
      steps: store.all("SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY position ASC", campaign.id),
      stats: campaignStats(campaign.id),
    }))
  }

  function getCampaign(campaignId) {
    const campaign = store.get("SELECT * FROM campaigns WHERE id = ?", campaignId)
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`)
    return {
      ...campaign,
      steps: store.all("SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY position ASC", campaignId),
      stats: campaignStats(campaignId),
    }
  }

  function createCampaign(params) {
    const name = String(params.name || "").trim()
    if (!name) throw new Error("Campaign name is required")
    const account = getAccount(params.accountId)
    const steps = Array.isArray(params.steps) ? params.steps : []
    if (!steps.length) throw new Error("At least one campaign step is required")
    const mode = params.mode === "send" ? "send" : "draft"
    const id = randomUUID()
    const now = nowIso()

    store.transaction(() => {
      store.run(
        "INSERT INTO campaigns (id, name, account_id, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
        id,
        name,
        account.id,
        mode,
        now,
        now,
      )
      steps.forEach((step, index) => {
        if (!step?.subject || !step?.body) throw new Error(`Step ${index + 1} needs subject and body`)
        store.run(
          "INSERT INTO campaign_steps (campaign_id, position, delay_days, subject, body, html) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          index,
          Number(step.delayDays || (index === 0 ? 0 : 3)),
          step.subject,
          step.body,
          step.html || null,
        )
      })
    })

    store.event("campaign.created", { accountId: account.id, data: { id, name, mode, steps: steps.length } })
    return getCampaign(id)
  }

  function setCampaignStatus(campaignId, status) {
    if (!["draft", "running", "paused", "done"].includes(status)) throw new Error("Invalid campaign status")
    getCampaign(campaignId)
    store.run("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), campaignId)
    store.event("campaign.status", { data: { campaignId, status } })
    return getCampaign(campaignId)
  }

  function pauseAll() {
    const result = store.run("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE status = 'running'", nowIso())
    store.event("campaign.paused_all", { data: { count: result.changes } })
    return { paused: result.changes || 0 }
  }

  function resumeAll() {
    const result = store.run("UPDATE campaigns SET status = 'running', updated_at = ? WHERE status = 'paused'", nowIso())
    store.event("campaign.resumed_all", { data: { count: result.changes } })
    return { resumed: result.changes || 0 }
  }

  function enrolContacts(params) {
    const cfg = config()
    const campaign = getCampaign(params.campaignId)
    const inputs = (Array.isArray(params.contacts) ? params.contacts : []).map((entry) =>
      typeof entry === "string" ? { email: entry } : entry,
    )
    if (!inputs.length) throw new Error("No contacts supplied")

    const firstStep = campaign.steps[0]
    let added = 0
    let skipped = 0
    let skippedActive = 0

    for (const input of inputs) {
      const email = normalizeEmail(input.email)
      if (!email || !isEmail(email)) {
        skipped += 1
        continue
      }
      if (contacts.isSuppressed(email) || contacts.contactBlockReason(email)) {
        skipped += 1
        continue
      }
      if (cfg.requireConsent) {
        const contact = contacts.getContact(email)
        if (!contact?.consent_at && !input.consentAt) {
          skipped += 1
          continue
        }
      }
      if (!cfg.allowMultipleCampaigns && enrolments.hasActiveInOtherCampaign(email, campaign.id)) {
        skippedActive += 1
        continue
      }

      contacts.ensureContact({ ...input, source: input.source || `campaign:${campaign.name}` })
      const nextRunAt = new Date(Date.now() + Number(firstStep.delay_days || 0) * 86400_000).toISOString()
      const result = enrolments.createEnrolment({ campaignId: campaign.id, email, nextRunAt })
      if (result.changes) added += 1
      else skipped += 1
    }

    store.event("campaign.enrolled", { data: { campaignId: campaign.id, added, skipped, skippedActive } })
    return { campaignId: campaign.id, added, skipped, skippedActive, status: campaign.status }
  }

  async function previewCampaign(campaignId, params = {}) {
    const campaign = getCampaign(campaignId)
    const account = getAccount(campaign.account_id)
    const to = params.to || account.email
    const sampleContact = params.contactEmail
      ? contacts.getContact(params.contactEmail)
      : store.get("SELECT * FROM contacts ORDER BY first_seen_at DESC LIMIT 1")

    const base = contactVars(sampleContact)
    const vars = {
      ...base,
      first_name: base.first_name || "Alex",
      name: base.name || "Alex Morgan",
      email: to,
      company: base.company || "Acme",
      title: base.title || "Founder",
      campaign: campaign.name,
    }

    const results = []
    for (const step of campaign.steps) {
      const result = await outbound.send({
        accountId: account.id,
        to,
        subject: render(step.subject, vars),
        text: render(step.body, vars),
        html: step.html ? render(step.html, vars) : null,
        bulk: true,
        preview: true,
        dedupe: false,
        dryRun: params.dryRun,
      })
      results.push({ step: step.position, id: result.id, subject: result.subject, status: result.status })
    }
    return { campaignId, to, results }
  }

  /** Cross-process claim so the daemon and a manual `campaign tick` never double-send. */
  function acquireTickLock(ttlMs = 120_000) {
    const now = Date.now()
    store.exec("BEGIN IMMEDIATE")
    try {
      const row = store.get("SELECT value FROM kv WHERE key = 'tickLock'")
      const lock = row?.value ? JSON.parse(row.value) : null
      if (lock && now - Number(lock.at) < ttlMs) {
        store.exec("ROLLBACK")
        return false
      }
      store.run(
        "INSERT INTO kv (key, value) VALUES ('tickLock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify({ at: now, pid: process.pid }),
      )
      store.exec("COMMIT")
      return true
    } catch (error) {
      try {
        store.exec("ROLLBACK")
      } catch {}
      throw error
    }
  }

  function releaseTickLock() {
    try {
      store.setKv("tickLock", { at: 0 })
    } catch {}
  }

  async function tickCampaigns() {
    const cfg = config()
    if (!inBusinessWindow(new Date(), cfg)) return { skipped: "outside-business-hours", started: 0 }

    let locked = false
    try {
      locked = acquireTickLock()
    } catch {
      locked = false
    }
    if (!locked) return { skipped: "another-tick-in-progress", started: 0 }

    try {
      const due = enrolments.dueEnrolments(clamp(cfg.maxPerTick || 25, 1, 100))
      const results = []

      for (const row of due) {
        try {
          if (contacts.isSuppressed(row.contact_email)) {
            enrolments.markState(row.enrolment_id, "suppressed")
            continue
          }

          const block = contacts.contactBlockReason(row.contact_email)
          if (block) {
            enrolments.markState(row.enrolment_id, "blocked")
            store.event("campaign.step.blocked", { email: row.contact_email, data: { campaignId: row.campaign_id, reason: block } })
            continue
          }

          const account = getAccount(row.account_id)
          if (account.enabled === false) {
            enrolments.markState(row.enrolment_id, "active", new Date(Date.now() + 6 * 3600_000).toISOString())
            continue
          }

          const contact = contacts.getContact(row.contact_email) || contacts.ensureContact({ email: row.contact_email })
          const vars = { ...contactVars(contact), campaign: row.campaign_name }

          const lastOutbound = row.thread_id
            ? store.get(
                "SELECT rfc_message_id, refs FROM messages WHERE thread_id = ? AND direction = 'out' ORDER BY created_at DESC LIMIT 1",
                row.thread_id,
              )
            : null

          const payload = {
            accountId: account.id,
            to: row.contact_email,
            subject: render(row.step_subject, vars),
            text: render(row.step_body, vars),
            html: row.step_html ? render(row.step_html, vars) : null,
            threadId: row.thread_id || null,
            inReplyTo: lastOutbound?.rfc_message_id || null,
            references: lastOutbound ? [...parseRefs(lastOutbound.refs), lastOutbound.rfc_message_id] : [],
            campaignId: row.campaign_id,
            enrolmentId: row.enrolment_id,
            step: row.step_position,
            bulk: true,
            noFooter: false,
          }

          const outcome = row.mode === "send" ? await outbound.send(payload) : await outbound.createDraft(payload)
          const nextPosition = row.step_position + 1
          const nextStep = store.get(
            "SELECT * FROM campaign_steps WHERE campaign_id = ? AND position = ?",
            row.campaign_id,
            nextPosition,
          )

          if (!nextStep) {
            enrolments.advance({
              id: row.enrolment_id,
              position: nextPosition,
              threadId: outcome.threadId,
              messageId: outcome.id,
              nextRunAt: null,
              state: "done",
            })
          } else {
            const jitter = Number(nextStep.delay_days || 0) > 0 ? Math.floor(Math.random() * 4 * 3600_000) : 0
            const nextRunAt = new Date(Date.now() + Number(nextStep.delay_days || 0) * 86400_000 + jitter).toISOString()
            enrolments.advance({
              id: row.enrolment_id,
              position: nextPosition,
              threadId: outcome.threadId,
              messageId: outcome.id,
              nextRunAt,
            })
          }

          results.push({ enrolment: row.enrolment_id, email: row.contact_email, step: row.step_position, mode: row.mode, id: outcome.id })
          store.event("campaign.step", {
            accountId: account.id,
            email: row.contact_email,
            data: { campaignId: row.campaign_id, step: row.step_position, mode: row.mode, outcomeId: outcome.id },
          })
        } catch (error) {
          const message = String(error.message || error)
          store.event("campaign.step.failed", {
            email: row.contact_email,
            data: { campaignId: row.campaign_id, step: row.step_position, error: message },
          })
          const delayMs = /limit reached/i.test(message) ? 3600_000 : 900_000
          enrolments.markState(row.enrolment_id, "active", new Date(Date.now() + delayMs).toISOString())
          results.push({ enrolment: row.enrolment_id, email: row.contact_email, error: message })
        }
      }

      return { started: results.length, results }
    } finally {
      releaseTickLock()
    }
  }

  return {
    listCampaigns,
    getCampaign,
    createCampaign,
    setCampaignStatus,
    pauseAll,
    resumeAll,
    enrolContacts,
    previewCampaign,
    tickCampaigns,
  }
}
