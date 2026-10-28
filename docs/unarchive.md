# Archived chat restoration

The native `thread/unarchive` response contains the restored thread metadata.
The archive coordinator inserts that response into the thread store, clears the
archived suppression, and broadcasts the change to peers. It does not perform
a second hydration before reporting success. This keeps restoration independent
of notification delivery and subsequent history loading.

An unarchive notification can arrive while a thread is unavailable, including
notifications from another native IPC client. Metadata refresh failures are
logged and leave the thread list invalidated. They must not escape as an
unhandled rejection and terminate the Web backend. Later notifications can
refresh the thread normally.

`scripts/unarchive-patch.mjs` applies the same changes to the native host and
browser manager. Full and Lite use the same archive behavior.
`scripts/test-unarchive.cjs` exercises those native coordinators with a missing
notification and with a failed metadata lookup.

Native Windows IPC uses a global named pipe. Complete application fixtures must
replace the pipe endpoint in their isolated module loader before loading native
modules; setting `CODEX_HOME` alone does not isolate that channel. Fixture
archive broadcasts must never reach a running user's application.
