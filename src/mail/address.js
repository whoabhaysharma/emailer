const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/

export function isEmail(value) {
  return EMAIL_RE.test(String(value || "").trim())
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase()
}

export function toAddressList(value) {
  if (!value) return []
  const list = Array.isArray(value) ? value : String(value).split(/[,;]/)
  return list
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(.*)<([^>]+)>$/)
      return match ? { name: match[1].trim().replace(/^"|"$/g, ""), address: normalizeEmail(match[2]) } : { name: "", address: normalizeEmail(entry) }
    })
    .filter((entry) => isEmail(entry.address))
}

export function formatAddress(account) {
  if (!account) return ""
  const name = account.displayName || account.email
  return `${name} <${account.email}>`
}

export function domainOf(email) {
  const at = String(email || "").lastIndexOf("@")
  return at === -1 ? "" : String(email).slice(at + 1).toLowerCase()
}

export function firstName(name, email) {
  const value = String(name || "").trim()
  if (value) return value.split(/\s+/)[0]
  const local = String(email || "").split("@")[0].replace(/[._-]+/g, " ")
  return local.split(/\s+/)[0].replace(/^\w/, (c) => c.toUpperCase())
}
