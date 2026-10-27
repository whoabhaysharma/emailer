---
description: Design a sequence, preview the copy, and enrol contacts
agent: email-marketer
---

Build an outbound sequence for: $ARGUMENTS

Steps:

1. Load the `email-playbook` skill.
2. Read `email.accounts`, `email.stats`, and `email.suppressions`.
3. Propose 3-4 steps: first touch plus follow-ups. For each: day offset,
   subject, body. Keep the first touch under 90 words. No placeholders other
   than `{{first_name}}`, `{{company}}`, `{{title}}`, `{{email}}`.
4. Show the full copy and the volume math: contacts x steps, per account, per
   day, against each account's remaining daily capacity and warmup limit.
5. Create it with `email.campaign_create` using `mode: "draft"` unless the user
   explicitly asked for automatic sending.
6. Call `email.campaign_preview` so the user sees exactly what will arrive
   (previews go to the account owner).
7. Enrol only the contacts the user named. If they gave a file, ask them to
   provide the path.
8. Start when the user says go. A clear "start it" in chat is enough; you do not
   need a separate formal approval.

You can start a campaign in the same turn when the user said to start it.
Otherwise show the preview first. If anything looks wrong while a campaign is
running, call `email.pause_all` first and ask questions later.
