---
description: Triage new replies, classify them, and prepare draft responses
agent: email-marketer
---

Run the inbox routine.

1. `email.health` and `email.stats` for context.
2. `email.sync` if the last sync is older than ten minutes.
3. `email.unclassified` (limit 20). For each message:
   - read `email.thread`
   - classify with `email.classify` (include `notBefore` for `not_now`)
   - if a reply is warranted, create it with `email.reply` (draft only)
4. `email.drafts` status pending: list what is waiting for the human to send.
5. Summarise in four short sections: hot, needs a human decision, drafted
   replies, opt-outs and bounces. Include counts and one line per person.

Do not send anything. Do not classify the same message twice. Newsletters and
auto-replies are usually already classified by rules; do not treat them as replies.
