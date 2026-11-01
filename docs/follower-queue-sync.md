# Follower queue synchronization

When Desktop owns a running thread, a browser submits queued messages through
the existing follower request. The owner persists the queue before acknowledging
the request. Queue broadcasts do not contain a revision, so an older snapshot
can arrive while a newer write is pending and replace the browser's optimistic
entry. Reloading reads the persisted entry and makes it visible again.

The Web host treats owner broadcasts as invalidations of its shared queue
storage. It reads through the existing queue storage interface after an accepted
follower write and after a broadcast from the current owner. This relies on the
Desktop and Web host using the same queue storage, as in the supported local
Desktop bridge deployment. It does not introduce a remote storage protocol.

Reads are coalesced by thread and owner. Each thread has its own local revision
counter, so unrelated thread activity cannot invalidate a read. A read retries
at most three times when the same queue changes during loading. Read failures
or continued contention preserve the current queue and report an operation
failure; later notifications can retry. Revisions are local invalidation guards,
not revisions of the owner protocol. Owner writes, message execution, permission
checks, and persisted queue formats retain their existing behavior.

The patch is applied to both the Web host's native coordinator and the shared
browser bundle. Full and Lite are generated from that shared bundle. It does not
modify the installed Desktop application. Tests run the pinned coordinators with
isolated storage and an owner fixture; they cover stale broadcasts, accepted and
rejected writes, peer edits and deletions, read races and failures, unrelated
threads, bounded retries, owner replacement, and disposal.
