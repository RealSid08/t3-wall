## What changed

<!-- A short description of the change and the motivation for it. -->

## Checklist

- [ ] t3-wall stays a **read-only sidecar** (no writes to T3 Code or its DB)
- [ ] Missing data sources degrade gracefully (no T3 home / no openusage / offline peer)
- [ ] No secrets, tokens, or credentials added to code, logs, or commits
- [ ] `bun build server.ts --target=bun` succeeds
- [ ] `shellcheck install.sh kiosk.sh start-server.sh` is clean
- [ ] `README.md` updated if behaviour or configuration changed

## Notes for reviewers

<!-- Anything that needs special attention, screenshots, follow-ups. -->
