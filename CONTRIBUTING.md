# Contributing to t3-wall

Thanks for taking a look. t3-wall is a **read-only sidecar**: it never modifies,
restarts, or reconfigures T3 Code. Keep that invariant in mind — it is the whole
point of the project.

## Ground rules

- **Never write to T3 Code.** No writes to `~/.t3`, its SQLite database, or its
  settings. Reads only (`readonly: true` for SQLite).
- **Degrade gracefully.** Every data source is optional: no T3 home, no
  `openusage`, or an unreachable peer must not crash the server or block a
  request. Missing data renders as empty/zero, never as an error page.
- **No secrets, ever.** The wall must not log tokens, session cookies, or
  credentials. Do not commit `.env` files, keys, or captured auth state.
- **Stay dependency-light.** Bun + the standard library. Avoid adding npm
  packages unless there is no reasonable alternative.

## Development

Requirements: [Bun](https://bun.sh) and, for the full experience, T3 Code and the
[`openusage`](https://openusage.app) CLI.

```sh
./start-server.sh            # http://127.0.0.1:4123
./kiosk.sh                   # fullscreen on the external display
```

Run the same checks CI runs before opening a pull request:

```sh
bun build server.ts --target=bun --outdir=/tmp/t3-wall-build
shellcheck install.sh kiosk.sh start-server.sh
```

## Pull requests

- One focused change per pull request; explain the *why* in the description.
- Keep the diff clean and match the surrounding style (no drive-by reformatting).
- If you change behaviour, update `README.md`.
- Use conventional commit subjects (`feat:`, `fix:`, `docs:`, `chore:`) where
  practical.

## Reporting bugs

Open an issue with your macOS version, T3 Code version, and whether `openusage`
and any peers are configured. Redact anything sensitive (thread titles, paths,
account names) before posting logs.
