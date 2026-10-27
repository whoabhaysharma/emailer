import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { changelogSection, compareVersions, parseVersion } from "../src/cli/commands/update.js"

const changelog = readFileSync(join(import.meta.dirname, "..", "CHANGELOG.md"), "utf8")

test("parseVersion reads semver with and without a v prefix", () => {
  assert.deepEqual(parseVersion("v0.2.0"), [0, 2, 0])
  assert.deepEqual(parseVersion("0.2.0"), [0, 2, 0])
  assert.deepEqual(parseVersion("  v12.34.56  "), [12, 34, 56])
})

test("parseVersion rejects non-semver values", () => {
  for (const value of ["", "latest", "v1.2", "1.2.3.4", "v1.2.3-rc.1", null, undefined]) {
    assert.equal(parseVersion(value), null, `${String(value)} should be invalid`)
  }
})

test("compareVersions orders releases", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1)
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0)
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0)
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1)
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1)
})

test("changelogSection extracts a release block without the next one", () => {
  const section = changelogSection(changelog, "0.2.0")
  assert.match(section, /^## \[0\.2\.0\] - 2026-10-27/)
  assert.match(section, /### Added/)
  assert.match(section, /update \[--check\]/)
  assert.doesNotMatch(section, /## \[0\.1\.0\]/)
  assert.equal(changelogSection(changelog, "v0.2.0"), section)
})

test("changelogSection returns an empty string for unknown versions", () => {
  assert.equal(changelogSection(changelog, "9.9.9"), "")
  assert.equal(changelogSection("", "0.2.0"), "")
  assert.equal(changelogSection(changelog, "not-a-version"), "")
})
