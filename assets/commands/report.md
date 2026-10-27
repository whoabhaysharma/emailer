---
description: Report sends, replies, intents, and campaign performance
agent: email-marketer
---

Report on the email operation for: $ARGUMENTS

Use `email.stats` and `email.campaigns`. Report only measured numbers.

Include:

1. Per account: sends in the last 24h vs daily limit, last sync time.
2. Funnel: contacts, sends, replies, reply rate, positive intent count,
   drafts pending, suppressed count.
3. Intent breakdown from `email.stats.intents`.
4. Per running campaign: enrolled, active, replied, done, suppressed.
5. What changed since the last report, if the user asks for a comparison.
6. Three concrete recommendations, ranked by expected effect. Each must cite a
   number from above.

Never estimate open rates or claim a metric the tools do not return.
