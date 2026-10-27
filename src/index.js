import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { makeClient } from "./client.js"
import { createTools } from "./tools/index.js"
import { DATA } from "./paths.js"

function logLoad(message) {
  try {
    mkdirSync(DATA, { recursive: true })
    appendFileSync(join(DATA, "plugin.log"), `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

function permissionResource(toolName, input) {
  if (["send", "draft", "reply"].includes(toolName)) return input.accountId || "*"
  if (toolName === "suppress") return String(input.emails || "*")
  return "*"
}

/**
 * OpenCode plugin entry.
 *
 * Deliberately dependency-free: it only talks HTTP to the local daemon, so it
 * loads in any OpenCode runtime without native modules.
 */
export default {
  id: "email-agent",
  async setup(ctx) {
    logLoad("setup:start")
    const options = ctx.options || {}
    const namespace = String(options.namespace || "email").replace(/[^a-zA-Z0-9_-]/g, "") || "email"
    const client = makeClient({ baseUrl: options.baseUrl, autoStart: options.autoStart !== false })
    const tools = createTools(client)

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: namespace,
        description: "Multi-account email: send, Gmail drafts, reply tracking, drip campaigns",
      })

      for (const tool of tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          options: {
            namespace,
            codemode: true,
            ...(tool.permission ? { permission: tool.permission } : {}),
          },
          execute: async (input, context) => {
            if (tool.permission) {
              await ctx.permission.assert({
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
                action: tool.permission,
                resources: [permissionResource(tool.name, input || {})],
                metadata: { tool: `${namespace}.${tool.name}` },
              })
            }

            try {
              const result = await tool.execute(input, context)
              if (result && typeof result === "object" && result.error) return { content: `Error: ${result.error}` }
              return { content: typeof result === "string" ? result : JSON.stringify(result, null, 2) }
            } catch (error) {
              return { content: `Error: ${String(error?.message || error)}` }
            }
          },
        })
      }
    })
  },
}
