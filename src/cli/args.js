export function parseArgs(args) {
  const flags = {}
  const positional = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }

    const body = arg.slice(2)
    const eq = body.indexOf("=")
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }

    const next = args[index + 1]
    if (next && !next.startsWith("--")) {
      flags[body] = next
      index += 1
    } else {
      flags[body] = true
    }
  }

  return { flags, positional }
}
