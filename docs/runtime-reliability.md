# Runtime failure boundaries

The backend isolates failures at the operation that owns them. It does not
install a process-wide exception handler that treats arbitrary failures as safe.

## Native subscriptions

`native-rpc-subscription-patch.mjs` closes a native notification subscription when
its delivery cannot be serialized. The native depth limit remains unchanged.
The failed subscription releases its callback and temporary RPC capabilities;
other subscriptions continue. Diagnostics contain the failure category, never
the notification payload. The affected page must establish a new subscription
to receive that stream again.

The regression uses the pinned Desktop RPC implementation and real MessagePorts.
It exercises cyclic and deep values, unsupported values and a rejected initial
notification. Applying this host patch requires a backend restart.

## Diagnostic storage

Monitoring and console output each retain at most seven 10 MiB files with at
most 1 MiB pending writes per destination. A full or unavailable filesystem drops
diagnostic records, counts them and retries after 60 seconds. A single record
larger than the pending-write limit is dropped. Logging errors never log through
the failing destination. Native Desktop console output uses the same boundary.

`/__backend/health` reports `availableDiskBytes`, `droppedLogRecords` and
`consoleDroppedLogRecords`. These describe diagnostic storage; they do not imply
that business database writes succeeded.

`ops/log-retention.ps1` provides helpers for a deployment supervisor. The log
retention helper keeps seven generations of timestamped stdout/stderr files;
the supervisor diagnostic helper rotates at 1 MiB. A supervisor integrating
these helpers should create distinct output files for each launch, record the
process identity, and keep retention failures from blocking startup.

Source checks and isolated tests do not establish that a running backend has
loaded these changes. Activation must verify candidate hashes, wait for idle
sessions, replace only the identified backend and read health back through both
the local and public gateway paths.

## Native subagent retention

Run `node ops/native-thread-retention.mjs http://127.0.0.1:8214` once per minute
from the deployment scheduler. This uses the existing native IPC transport and
does not require a backend restart. The sweep unsubscribes persistent subagent
threads whose latest turn completed or failed at least five minutes ago. It
checks every ancestor and skips active, approval-waiting and question-waiting
families. It rechecks child metadata before unsubscribing. Interrupted turns,
unreadable metadata and ordinary user conversations are not eviction candidates.

Unsubscribing releases the app-server's in-memory subscription and MCP processes;
it does not archive or delete a conversation or close its collaboration identity.
The next normal use can resume that thread. This prevents completed invisible
subagents from retaining enough Windows stdio workers to stall configuration
reads and initialization while the HTTP health endpoint still responds.

`test-native-thread-retention.mjs` exercises the production sweep and native IPC
transport against an external app-server fixture, including pagination, repeated
sweeps, parent/child reactivation and metadata failures. Operational acceptance
must also check composer rendering in Full and Lite; HTTP 200 alone is insufficient.

The private reverse proxy serves entry HTML with `Cache-Control: private,no-store`.
Release-prefixed JavaScript and CSS retain their immutable cache policy. Verify
both a cold load and a normal cached reload; disabling the browser cache does
not establish that the normal reload path works.
