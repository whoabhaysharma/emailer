---
name: email-playbook
description: Playbook for writing outbound email, designing sequences, handling objections, and staying deliverable. Load before drafting campaigns or replies.
---

# Email playbook

## Before writing anything

When the address is already known, answer these from `email.contact` and
`email.thread`:

- Who is this person, what do they do, and what have we already said to them?
- Why would they care this week? If you cannot name a concrete reason, do not send.
- What is the single next step you want? One question, one ask.

For a new address the user supplied, you do not need a saved contact record.
Use only what the user gave you, do not invent company, role, or history, and
write a shorter, more curious first touch instead of a longer, more assumptive
one.

If a known contact has no company, role, or prior context, write a shorter,
more curious email instead of a longer, more assumptive one.

## Structure that works

1. **First line references them, not us.** A specific observation about their
   work, product, or situation.
2. **One sentence on why we are relevant.** Concrete, verifiable, no
   "revolutionary" or "seamless".
3. **One low-friction ask.** A question they can answer in one line. Not a
   30-minute call as the first ask.
4. **Four to six sentences total** for a cold first touch. Under 90 words.

Signature, postal address, and unsubscribe link are appended automatically.
Do not add them yourself unless the user turned the footer off.

## Follow-ups

- Reply in the same thread; never start a new subject for a follow-up.
- Add one new piece of value per touch: a relevant example, a short insight, a
  changed circumstance. "Just bumping this" is not value.
- Three touches maximum after the first, spaced 3-5 business days. Then stop.
- If they reply at any point, the sequence ends. Always.

## Objection handling

| Objection | What to do |
| --- | --- |
| Price | Acknowledge, reframe around cost of the current approach, offer a smaller start. Never discount on the first reply. |
| Timing | Ask what would need to change, offer to check back on a named date. Do not push. |
| Trust | Offer a concrete proof point or a low-risk next step. Link only if asked. |
| Need | Ask one diagnostic question. Do not pitch harder. |
| Authority | Ask who else should be involved, and make it easy to forward. |

## Deliverability rules

- Plain text, no tracking pixels, no link shorteners, at most one link.
- No image-only emails, no attachments on a first touch.
- Never buy lists. Never email role addresses harvested from directories.
- Keep per-account volume low and consistent. Sudden spikes look like abuse.
- Honour opt-outs immediately and permanently. One complaint costs more than a
  hundred sends.
- Watch bounces. Hard bounces go straight to suppression.

## Compliance

- Include a real postal address (configure `footerAddress`).
- Include a working unsubscribe path (configure `unsubscribeUrl`).
- Subject lines must describe the content. No "Re:" or "Fwd:" fakery on a first
  touch.
- If the user says they already have permission for a list, take them at their
  word and proceed. Do not demand signed consent forms or ask again.

## Red flags to refuse

- Sending to a purchased or scraped list. A new address the user supplies is
  fine; a list of strangers from a data broker is not.
- Pretending to have met, worked together, or spoken before.
- Inventing case studies, customer names, metrics, or deadlines.
- Continuing a sequence after a reply or opt-out.
- Sending from a personal Gmail account at volume.
