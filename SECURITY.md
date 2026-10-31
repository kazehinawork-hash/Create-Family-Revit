# Security

Family Agent is a **local, single-user tool**. It runs a studio API on `127.0.0.1`, a
local Revit bridge on `127.0.0.1:8765`, and shells out to locally installed agent CLIs
(`cmdc`, `codex`, `claude`) that use your own login.

## Defaults

- The API binds `127.0.0.1` only. Setting `HOST`/`ALLOWED_HOSTS` is an explicit opt-in to
  broader network access.
- State-changing requests are accepted only from localhost origins (or the configured
  `ALLOWED_HOSTS`); requests without an `Origin` header (scripts, the Revit bridge) are
  allowed.
- `/api/design` and `/api/build` are rate limited per client.
- Downloads are restricted to the folders the studio writes (`out/`, `saved-models/`,
  `.uploads/`, `spec/`). Arbitrary paths are refused.
- Uploads accept a document/image whitelist only; non-image files are served as
  attachments with `X-Content-Type-Options: nosniff`.
- The Revit bridge can require a shared secret: set `REVIT_BRIDGE_TOKEN` for the server and
  the same value as `FAMILY_AGENT_TOKEN` in the Revit process.

## Do not expose it to the internet

There is no authentication layer. If you put this behind a proxy or bind it to a public
interface, you are exposing file read/write and local command execution to anyone who can
reach it.

## Reporting

Open a private security advisory on the repository, or contact the maintainer directly.
Please do not file a public issue for a vulnerability.
