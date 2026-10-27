import { createHmac, timingSafeEqual } from "node:crypto"

/** Signed, stateless unsubscribe token: base64url(email).hmac */
export function signUnsubscribe(secret, email) {
  const payload = Buffer.from(String(email || "").toLowerCase()).toString("base64url")
  const signature = createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 24)
  return `${payload}.${signature}`
}

export function verifyUnsubscribe(secret, token) {
  const [payload, signature] = String(token || "").split(".")
  if (!payload || !signature) return null
  const expected = createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 24)
  const left = Buffer.from(signature)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null
  try {
    return Buffer.from(payload, "base64url").toString("utf8")
  } catch {
    return null
  }
}
