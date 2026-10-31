# Changelog

## 0.1.1 - 2026-10-31

- Scrub NUL bytes out of outgoing requests. The web endpoint answers
  `400 String must not contain null bytes` when one reaches `systemPrompt`, which
  breaks a session permanently; NUL bytes routinely arrive from `grep -a` /
  `cat` / `tail` over binary files. A raw control byte in a request body is now
  repaired before parsing too.
- Optional `--with-nul-plugin`: installs an OpenCode plugin that does the same
  for other providers (the official API has the same limit).

## 0.1.0 - 2026-10-31

Initial release.

- Local OpenAI-compatible proxy for the venice.ai web session (Clerk cookie auth, no password, no API key).
- 20 free web models, exposed as an OpenCode provider.
- Tool-call emulation with reliability safeguards: format reminder, single automatic retry, multi-envelope parsing, history normalisation, Code Mode wrapper filtering.
- `login`, `sync`, `doctor` CLIs, launchd/systemd install, unit + smoke tests.
