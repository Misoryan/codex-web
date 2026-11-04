# Machine HTTP API

`node ops/machine-api.mjs` runs a separate, loopback-only HTTP service. It uses
the existing native bridge without loading a frontend or restarting its host.
It reuses the repository's Fastify and ws dependencies. Its public prefix is
`/codex/api/v1/`; the reverse proxy must preserve this prefix and Authorization.

Configure these server-side environment variables:

| Variable | Purpose |
| --- | --- |
| `CODEX_API_NATIVE_URL` | Loopback native IPC WebSocket URL |
| `CODEX_API_TOKEN_HASH_FILE` | File containing the SHA-256 hex digest of a random 32-byte base64url token |
| `CODEX_API_PORT` | Loopback HTTP listener port, default 8231 |
| `CODEX_API_STATE_ROOT` | Fixed assistant state directory; omit to disable state routes |
| `CODEX_API_PWSH` | Absolute PowerShell 7 executable path |
| `CODEX_API_STATE_SCRIPT` | Fixed state memory command script |
| `CODEX_API_PYTHON_SCRIPT` | Fixed Python launcher script |
| `CODEX_API_TICKET_SCRIPT` | The state root's tickets/ticket.py script |

Token digests are reread on every request. Emptying, deleting or replacing the
digest file immediately revokes the old credential. Keep both the distributed
token and server digest private with operating-system file permissions. Never
put the token in a URL. No browser cookies, HTML, approval decisions, arbitrary
RPC, shell, filesystem or administration endpoints are exposed by this service.
The browser site's existing authentication must remain in place.

Authenticated requests are limited to 120 per minute and 8 in flight. Anonymous
requests have a separate 240-per-minute budget. Request bodies are limited to
64 KiB. The service does not trust forwarding headers for authorization.

Thread endpoints:

- `GET /health`, `/models`, `/profiles`
- `POST /threads`: `{cwd,message,profile?,model?,effort?,title?}`; returns threadId and turnId
- `GET /threads`: cursor, limit, archived, cwd, searchTerm query parameters
- `GET /threads/:id`: metadata without history hydration
- `GET /threads/:id/turns`: cursor, limit, itemsView query parameters
- `GET /threads/:id/items`: required turnId, optional cursor and limit
- `POST /threads/:id/messages`: `{message,model?,effort?}`; idle threads only
- `POST /threads/:id/steer`: `{message,expectedTurnId}`
- `POST /threads/:id/interrupt`: `{turnId}`
- `POST /threads/:id/archive` and `/unarchive`: `{}`
- `GET /threads/:id/events`: optional after and epoch query parameters

Profiles resolve from the native host's configured profile table. The `default`
profile inherits host configuration; an explicit model overrides the profile.
This service never accepts client permission or arbitrary config overrides.
Creation is thread/start followed by an optional title and turn/start. A partial
failure includes threadId when already known. Mutations are never retried by
the service; after a timeout or disconnection, reconcile native history before
resending. Messages refuse active threads; steering uses the native turn ID
precondition. External desktop clients may still mutate the same thread.

Events retain the latest 4000 native thread notifications in memory. Pollers
must retain both epoch and nextAfter. A changed epoch or gap requires reading
canonical turn/item history. A turn is finished only when its own native status
is completed, failed or interrupted; thread idle alone is insufficient. The
event feed is observational and never answers native approval requests.

State endpoints:

- `GET /state/files`: catalog of explicitly allowed existing files
- `GET /state/file?path=...`: UTF-8 content, maximum 2 MiB
- `POST /state/memory`: `{profile,text}`; profile is grokbot or ec-feedback,
  text is one nonempty line of at most 4000 characters
- `GET /state/tickets?open=true`: ticket command list output as text
- `GET /state/tickets/:id`: ticket command show result
- `POST /state/tickets/:id`: optional stage, waiting_on, last_event.summary

The file allowlist is memory/views/grokbot/MEMORY.md,
memory/views/ec-feedback/MEMORY.md, memory/grokbot-delta-*.md,
handoff/*.json and the pending-work Markdown file named by the implementation.
Dynamic filenames allow only letters, numbers, hyphens and underscores.
Traversal, separators outside this contract, alternate streams and symbolic
links/junctions are rejected. Secrets and direct ledger file access are denied.

Memory writes call the fixed state script with put, profile, source=dots and
text. Its put command must accept dots as a source. Ticket reads call only list
or show; updates first show an existing ticket and then call upsert with a
validated partial object. Clients cannot create tickets or change IDs, refs,
titles, cursors, timestamps or script/root paths. Child processes use execFile
with argument arrays, shell=false, a 30-second timeout and fixed state-root
environment variables. No request becomes a shell command.

Writes append requested and succeeded/failed audit entries to
events/dots-api-audit.jsonl. Entries contain time, interface, source and a
summary (field names or text length/hash), never credentials or command output.

Run `node scripts/test-machine-api.mjs`. To exercise actual installed state and
ticket scripts against an isolated fixture, set CODEX_API_TEST_PWSH,
CODEX_API_TEST_STATE_SCRIPT, CODEX_API_TEST_PYTHON_SCRIPT and
CODEX_API_TEST_TICKET_SCRIPT, then run `node scripts/test-machine-state.mjs`.
Fixtures are printed for the caller to remove after checking their ownership.
