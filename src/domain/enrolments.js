import { randomUUID } from "node:crypto"
import { normalizeEmail } from "../mail/address.js"
import { daysFromNow, nowIso } from "./shared.js"

export function createEnrolments({ store }) {
  function stopEnrolments(email, state = "replied") {
    const result = store.run(
      "UPDATE enrolments SET state = ?, updated_at = ? WHERE contact_email = ? AND state = 'active'",
      state,
      nowIso(),
      normalizeEmail(email),
    )
    return result.changes || 0
  }

  function delayEnrolments(email, days) {
    const until = daysFromNow(days)
    return store.run(
      `UPDATE enrolments SET next_run_at = ?, updated_at = ?
       WHERE contact_email = ? AND state = 'active' AND (next_run_at IS NULL OR next_run_at < ?)`,
      until,
      nowIso(),
      normalizeEmail(email),
      until,
    ).changes
  }

  function hasActiveInOtherCampaign(email, campaignId) {
    return Boolean(
      store.get(
        "SELECT id FROM enrolments WHERE contact_email = ? AND state = 'active' AND campaign_id != ? LIMIT 1",
        normalizeEmail(email),
        campaignId,
      ),
    )
  }

  function createEnrolment({ campaignId, email, nextRunAt }) {
    return store.run(
      `INSERT OR IGNORE INTO enrolments (id, campaign_id, contact_email, step_position, state, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'active', ?, ?, ?)`,
      randomUUID(),
      campaignId,
      normalizeEmail(email),
      nextRunAt,
      nowIso(),
      nowIso(),
    )
  }

  function markState(id, state, nextRunAt = null) {
    store.run(
      "UPDATE enrolments SET state = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      state,
      nextRunAt,
      nowIso(),
      id,
    )
  }

  function advance({ id, position, threadId, messageId, nextRunAt, state = "active" }) {
    store.run(
      `UPDATE enrolments SET state = ?, step_position = ?, thread_id = ?, last_message_id = ?,
         next_run_at = ?, updated_at = ? WHERE id = ?`,
      state,
      position,
      threadId,
      messageId,
      nextRunAt,
      nowIso(),
      id,
    )
  }

  function dueEnrolments(limit) {
    return store.all(
      `SELECT e.id AS enrolment_id, e.step_position, e.campaign_id, e.contact_email, e.thread_id, e.last_message_id,
              c.name AS campaign_name, c.account_id, c.mode,
              s.subject AS step_subject, s.body AS step_body, s.html AS step_html
       FROM enrolments e
       JOIN campaigns c ON c.id = e.campaign_id
       JOIN campaign_steps s ON s.campaign_id = e.campaign_id AND s.position = e.step_position
       WHERE e.state = 'active' AND c.status = 'running' AND e.next_run_at <= ?
       ORDER BY e.next_run_at ASC LIMIT ?`,
      nowIso(),
      limit,
    )
  }

  return {
    stopEnrolments,
    delayEnrolments,
    hasActiveInOtherCampaign,
    createEnrolment,
    markState,
    advance,
    dueEnrolments,
  }
}
