export const VERSION = "0.4.3"
export const MIN_NODE_MAJOR = 22
export const MIN_NODE_MINOR = 5

export function nodeVersionOk(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number)
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)
}
