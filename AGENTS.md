# Repository guidance

Keep this repository limited to reusable source, patches and documentation. User profiles, credentials, deployment addresses, conversation captures and generated application bundles belong outside Git.

Build with `npm run build` from the pinned archive in `desktop.json`. Do not copy an existing installation's extracted application into a commit. Keep Full and Lite behavior consistent when changing a patch.

Run `npm test` for server and isolated browser checks. Run `npm run test:desktop` after changing Desktop patches or PWA resources. Use fixtures; do not send test messages, resume real chats or exercise real approvals.

Before committing or pushing, run the privacy audit with Gitleaks installed. Use a GitHub noreply address for new commits. Keep upstream author attribution intact.

Prefer the simplest current implementation. Remove obsolete version branches, scripts and tests instead of adding compatibility paths. Keep changes scoped to the requested behavior.
