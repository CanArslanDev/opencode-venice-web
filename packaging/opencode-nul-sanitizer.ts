/**
 * venice-web-nul-sanitizer - optional OpenCode plugin.
 *
 * The proxy already scrubs NUL bytes out of everything it sends, so this plugin
 * is NOT needed for the `venice-web` provider. Install it if you also talk to
 * other providers straight from OpenCode (the official Venice API rejects
 * "String must not contain null bytes" the same way, and a NUL byte stored in a
 * session breaks that session for good).
 *
 * Background: reading a binary file with `grep -a`, `cat` or `tail` puts NUL
 * bytes into a tool result, from there into the stored conversation, and from
 * there into every later request.
 *
 * Install: copy this file to ~/.config/opencode/plugins/ (or run
 * `install.sh --with-nul-plugin`). It only rewrites the outgoing request; the
 * stored history is untouched.
 *
 * Authoring API: OpenCode v2 promise plugins (`@opencode/plugin`).
 */
import { Plugin } from "@opencode/plugin"

const NUL = "\u0000"

function scrub(value: unknown): number {
  let changed = 0

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index]
      if (typeof item === "string") {
        if (item.includes(NUL)) {
          value[index] = item.replaceAll(NUL, " ")
          changed++
        }
      } else {
        changed += scrub(item)
      }
    }
    return changed
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const item = record[key]
      if (typeof item === "string") {
        if (item.includes(NUL)) {
          record[key] = item.replaceAll(NUL, " ")
          changed++
        }
      } else {
        changed += scrub(item)
      }
    }
  }

  return changed
}

export default Plugin.define({
  id: "venice-web-nul-sanitizer",

  async setup(ctx) {
    const onRequest = (event: any) => {
      const replaced = scrub(event.messages) + scrub(event.system)
      if (replaced > 0) {
        console.log(`[nul-sanitizer] scrubbed ${replaced} string(s) with NUL bytes (session ${event.sessionID})`)
      }
    }

    await ctx.session.hook("context", onRequest)
    await ctx.session.hook("compaction", onRequest)
    await ctx.session.hook("generate", onRequest)
    await ctx.session.hook("title", onRequest)

    // "Invalid request parameters" from a provider is often a NUL byte; retry
    // instead of giving up immediately.
    await ctx.session.hook("retry", (event: any) => {
      if (event.error?.type === "provider.invalid-request" && event.attempt <= 3) {
        event.decision = { retry: true, delay: 500 }
      }
    })

    console.log("[nul-sanitizer] loaded (NUL byte scrubbing for provider requests)")
  },
})
