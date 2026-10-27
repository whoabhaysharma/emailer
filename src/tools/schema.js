export const str = (description) => ({ type: "string", description })
export const num = (description) => ({ type: "number", description })
export const bool = (description) => ({ type: "boolean", description })

export function tool(name, description, input, options = {}) {
  return {
    name,
    description,
    input,
    permission: options.permission || null,
    execute: options.execute,
  }
}

export function call(context) {
  return { signal: context?.signal }
}
