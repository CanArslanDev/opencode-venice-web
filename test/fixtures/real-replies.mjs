/**
 * Model replies captured from real OpenCode sessions (deepseek-v4-1-flash-free,
 * 2026-10-31 .. 2026-11-04) that the proxy mishandled.
 *
 * Paths, names and file contents are shortened and anonymised, but the
 * structure - every bracket, quote and line break that made the reply break -
 * is kept exactly as the model wrote it. Each entry says what the proxy did with
 * it before the fix and what it must do now.
 */

/** The call object is never closed: `}]}` where `}}]}` belongs. The tool call was lost and the raw JSON was shown. */
export const MISSING_CALL_BRACE =
  '{"content":"Syntax and contract checks passed. Now running against the real sources.","tool_calls":[{"id":"call_4e6c755b","name":"shell","arguments":{"command":"node -e \'\\nconst p=(await import(\\"/home/user/provider/provider.mjs\\")).default;\\nshow(\\"hit\\", await p.fetchLyrics({title:\\"Song\\",artists:[\\"Artist\\"],lang:\\"tr\\"}));\\n\'","workdir":"/home/user/provider","timeout":120000}]}'

/**
 * `arguments` closed right after `oldString`, so `newString` sits on the call
 * object, and the call is not closed before the next one. The first edit reached
 * OpenCode without `newString` ("Invalid arguments for tool edit").
 */
export const EARLY_ARGUMENTS_CLOSE =
  '{"content":"","tool_calls":[\n{"name":"edit","arguments":{"path":"/home/user/project/meta/_journal.json","oldString":"    {\\n      \\"idx\\": 5\\n    }\\n  ]\\n}"},"newString":"    {\\n      \\"idx\\": 5\\n    },\\n    {\\n      \\"idx\\": 6\\n    }\\n  ]\\n}"\n,\n{"name":"edit","arguments":{"path":"/home/user/project/src/writes.ts","oldString":"  trackNumber?: number;","newString":"  trackNumber?: number;\\n  duration?: number;"}}\n]}'

/** Same slip on the last call, which then meets `]` while still open. */
export const EARLY_ARGUMENTS_CLOSE_LAST =
  '{"content":"","tool_calls":[{"name":"edit","arguments":{"path":"/home/user/project/docs/notes.md","oldString":"The provider throws when the network fails."},"newString":"The provider throws when every source it tried failed."\n]}'

/** A call left open between two calls: `"},\n{"name"`. Only the later call survived. */
export const OPEN_CALL_BETWEEN_CALLS =
  '{"content":"Now replacing the exact matching with word similarity.","tool_calls":[{"name":"edit","arguments":{"path":"/home/user/project/src/genius.ts","oldString":"const KEPT = 3;","newString":"const KEPT = 3;\\nconst MIN_SCORE = 0.6;"},\n{"name":"edit","arguments":{"path":"/home/user/project/src/genius.ts","oldString":"    if (fragment === \\"\\") continue;","newString":"    if (fragment === \\"\\") continue;\\n    const matched = matchLines(fragment, lines);"}}\n]}'

/** An envelope inside the content string of another envelope. The inner tool call was shown as text and never ran. */
export const NESTED_ENVELOPE =
  '{"content":"{\\"content\\":\\"Prettier reformatted the test file, so the suite runs once more.\\",\\"tool_calls\\":[{\\"id\\":\\"call_1\\",\\"name\\":\\"shell\\",\\"arguments\\":{\\"command\\":\\"npx vitest run src/sources\\",\\"timeout\\":300000}}]}","tool_calls":[]}'

/** DeepSeek's native tool-call markup trailing a valid envelope (half-formed: `parameter` where `invoke` belongs). */
export const DSML_TAIL =
  '{"content":"","tool_calls":[{"name":"shell","arguments":{"command":"echo hi"}}]}\n\n<｜DSML｜ parameter name="shell">\n<｜DSML｜ parameter name="command" string="true">echo hi</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>'

/** Native markup wrapped around the visible text of a turn. */
export const DSML_CONTENT_WRAPPER =
  '<parameter name="content">Let me read the files using the shell.\n</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>\n{"content":"","tool_calls":[{"name":"read","arguments":{"path":"/home/user/project/src/data.ts"}}]}'

/** An invented `tool_response` block in front of the envelope. */
export const INVENTED_TOOL_RESPONSE =
  '<tool_response>\n</tool_response>\n{"content":"","tool_calls":[{"name":"glob","arguments":{"pattern":"src/*.ts"}}]}'
