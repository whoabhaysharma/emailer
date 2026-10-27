import { withService } from "../context.js"
import { fail, parseContactsFile, printJson } from "../io.js"

export async function contactsCommand(action, flags, positional) {
  await withService(async (instance) => {
    if (!action || action === "list") {
      const contacts = instance.listContacts({ query: flags.query, status: flags.status, limit: flags.limit || 100 })
      if (flags.json) return printJson(contacts)

      console.table(
        contacts.map((contact) => ({
          email: contact.email,
          name: contact.name || "",
          company: contact.company || "",
          status: contact.status,
          consent: contact.consent_at ? "yes" : "",
          notBefore: contact.not_before ? String(contact.not_before).slice(0, 10) : "",
          lastContact: String(contact.last_contacted_at || "").slice(0, 10),
        })),
      )
      return
    }

    if (action === "import") {
      if (!flags.file) fail("--file contacts.csv|contacts.json is required")
      const contacts = parseContactsFile(flags.file)
      if (!contacts.length) fail("no contacts found in file")
      return printJson(
        instance.importContacts({
          contacts,
          source: flags.source || "import",
          consented: flags.consented === true,
        }),
      )
    }

    if (action === "show") {
      const email = positional[0]
      if (!email) fail("email is required")
      const contact = instance.getContact(email)
      if (!contact) fail(`contact not found: ${email}`)
      return printJson({ contact, messages: instance.searchMessages({ from: email, limit: 25 }) })
    }

    if (action === "status") {
      const email = positional[0]
      const status = positional[1]
      if (!email || !status) fail("usage: contacts status <email> <status>")
      return printJson(instance.setContactStatus(email, status, flags["not-before"]))
    }

    if (action === "prune") {
      return printJson(instance.pruneContacts({ dryRun: flags["dry-run"] === true }))
    }

    fail(`unknown contacts action: ${action}`)
  })
}
