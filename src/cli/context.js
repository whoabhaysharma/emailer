import { closeTransports } from "../mail/smtp.js"
import { createService } from "../service.js"
import { openStore } from "../store.js"

/** Run a command against a short-lived store + service, always closing both. */
export function withService(fn, file) {
  const instance = createService(openStore(file))
  return Promise.resolve(fn(instance)).finally(() => {
    closeTransports()
    instance.store.close()
  })
}
