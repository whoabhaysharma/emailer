import assert from "node:assert/strict"
import { test } from "node:test"
import {
  effectiveDailyLimit,
  inBusinessWindow,
  normalizeMessageId,
  referenceList,
} from "../src/domain/shared.js"

const utcConfig = {
  timezone: "UTC",
  businessHours: { start: 9, end: 18, days: [2] },
  defaultDailyLimit: 40,
}

test("normalizeMessageId adds brackets and handles arrays", () => {
  assert.equal(normalizeMessageId("<abc@example.com>"), "<abc@example.com>")
  assert.equal(normalizeMessageId("abc@example.com"), "<abc@example.com>")
  assert.equal(normalizeMessageId(["<first@example.com>", "<second@example.com>"]), "<first@example.com>")
  assert.equal(normalizeMessageId(null), null)
})

test("referenceList extracts every id and dedupes", () => {
  assert.deepEqual(referenceList("<a@x> <b@x>"), ["<a@x>", "<b@x>"])
  assert.deepEqual(referenceList(["<a@x>", "<a@x>"]), ["<a@x>"])
  assert.deepEqual(referenceList("plain-id"), ["<plain-id>"])
  assert.deepEqual(referenceList(undefined), [])
})

test("inBusinessWindow respects timezone, day, and hour", () => {
  // Tuesday 2026-10-27 12:00 UTC
  assert.equal(inBusinessWindow(new Date("2026-10-27T12:00:00Z"), utcConfig), true)
  assert.equal(inBusinessWindow(new Date("2026-10-27T20:00:00Z"), utcConfig), false)
  assert.equal(inBusinessWindow(new Date("2026-10-26T12:00:00Z"), utcConfig), false)
})

test("effectiveDailyLimit ramps warmup and respects the cap", () => {
  const cfg = { defaultDailyLimit: 40 }
  assert.equal(effectiveDailyLimit({ dailyLimit: 40 }, cfg), 40)

  const ramp = {
    dailyLimit: 60,
    warmup: { start: 10, incrementPerDay: 10, max: 40 },
    warmupStartedAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
  }
  assert.equal(effectiveDailyLimit(ramp, cfg), 30)

  const capped = { ...ramp, warmupStartedAt: new Date(Date.now() - 30 * 86400_000).toISOString() }
  assert.equal(effectiveDailyLimit(capped, cfg), 40)
})
