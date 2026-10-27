---
description: Clean and prepare a contact list before any outreach
agent: email-marketer
---

Prepare a prospect list for: $ARGUMENTS

1. Ask for the source file path if it was not given. One contact per line, or
   CSV with `email,name,company,title`.
2. Validate: dedupe by lowercased address, drop malformed addresses, drop
   anything already on `email.suppressions`, drop anyone who has replied
   "not now" or opted out, and drop existing customers unless the user says
   otherwise.
3. Report before enrolling anything: total, valid, duplicates removed,
   suppressed removed, missing names, missing company.
4. Do not enrich with guessed data. If a field is unknown, leave it empty -
   templates render empty strings.
5. Once the list looks clean, create or reuse a campaign and enrol. Start it
   when the user says go.

Never purchase, scrape, or guess addresses. If the list looks bought, say so and
stop.
