import { daemonStatus } from "../../daemon.js"
import { withService } from "../context.js"
import { buildDashboardModel, renderDashboard } from "../dashboard.js"

const CLEAR = "\x1b[2J\x1b[H"

/**
 * Print the dashboard once, as JSON, or refresh it in a loop.
 * All I/O lives here so the model and renderer stay pure and testable.
 */
export async function dashboardCommand(flags = {}) {
  const json = flags.json === true
  const watch = !json && flags.watch !== undefined && flags.watch !== false
  const color = flags["no-color"] !== true

  const once = () =>
    withService(async (instance) => {
      const model = buildDashboardModel(instance, { daemon: daemonStatus() })
      if (json) {
        console.log(JSON.stringify(model, null, 2))
        return
      }
      process.stdout.write(renderDashboard(model, { color }))
    })

  if (!watch) return once()

  const requested = typeof flags.watch === "string" ? flags.watch : flags.interval
  const seconds = Math.max(Number(requested || 30) || 30, 1)
  let stopped = false
  let wake = null

  const stop = () => {
    stopped = true
    wake?.()
  }

  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)

  try {
    while (!stopped) {
      process.stdout.write(CLEAR)
      try {
        await once()
      } catch (error) {
        process.stdout.write(`error: ${String(error?.message || error)}\n`)
      }
      if (stopped) break

      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve()
        }, seconds * 1000)
        wake = () => {
          clearTimeout(timer)
          wake = null
          resolve()
        }
      })
    }
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }

  process.stdout.write("\n")
}
