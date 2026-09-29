# Security policy

t3-wall is a local, read-only dashboard. It binds to `127.0.0.1` by default and
serves a small amount of data about your own machine and, optionally, peers you
reach over SSH.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use
GitHub's [private vulnerability reporting](https://github.com/RealSid08/t3-wall/security/advisories/new)
or email the maintainer. Include reproduction steps and the affected version.

## Threat model / what to keep in mind

- **Bind to loopback.** The default `T3_WALL_HOST=127.0.0.1` means the dashboard
  is only reachable from the machine itself. Only change it behind a trusted
  network or reverse proxy; the data it exposes (project names, thread titles,
  cost figures) is private.
- **Peers are trusted SSH hosts.** Cross-machine data is read over
  non-interactive SSH (`BatchMode=yes`) to hosts you configure in
  `T3_WALL_PEERS`. Only list machines you trust; the wall runs a short read-only
  Python query there.
- **Never commit secrets.** `~/.t3-wall/config*`, SSH keys, tokens, and the
  Chromium profile are local state and are gitignored.

Supported versions: the latest release only.
