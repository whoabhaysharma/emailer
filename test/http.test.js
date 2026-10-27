import assert from "node:assert/strict"
import { test } from "node:test"
import { createHttpServer } from "../src/http/server.js"

const service = {
  health: () => ({ ok: true }),
  listAccounts: () => [{ id: "sales" }],
  config: () => ({}),
}

async function withServer(fn) {
  const server = createHttpServer({ service, token: "secret", version: "test", logger: { error() {} } })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test("health is public", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.version, "test")
  })
})

test("protected routes require the bearer token", async () => {
  await withServer(async (base) => {
    const anonymous = await fetch(`${base}/accounts`)
    assert.equal(anonymous.status, 401)

    const authorized = await fetch(`${base}/accounts`, { headers: { authorization: "Bearer secret" } })
    assert.equal(authorized.status, 200)
    const body = await authorized.json()
    assert.deepEqual(body.accounts, [{ id: "sales" }])
  })
})

test("unknown routes return 404 and invalid unsubscribe tokens return 400", async () => {
  await withServer(async (base) => {
    const missing = await fetch(`${base}/nope`, { headers: { authorization: "Bearer secret" } })
    assert.equal(missing.status, 404)

    const invalid = await fetch(`${base}/u/not-a-token`)
    assert.equal(invalid.status, 400)
  })
})
