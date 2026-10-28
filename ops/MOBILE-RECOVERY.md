# Mobile recovery diagnostics

Returning from a hidden document replaces its old WebSocket immediately. The
document, renderer epoch, acknowledged event sequence and pending command sequence
stay intact. The server resumes the same renderer and confirms already executed
commands before the client sends pending commands again. An online event also
replaces an open transport; an already connecting transport is retained to avoid
duplicate connections when online and visibility events arrive together.

The normal 30-second inactivity watchdog remains in place for connections that
are making progress. Received frames renew it during a large replay. A foreground
return does not wait for that watchdog or for the operating system to detect an
old socket's failure.

## Server measurements

`session.buffer_profile` records retained bytes, event count and maximum event
size by a fixed protocol category at replay, detach, discard, and at most once
per minute under pressure above 1 MiB. `session.overflow` records the incoming
event category and size that would exceed the buffer limit. Acknowledged events
are removed from these totals. Unknown labels become `other` or `ipc-event-other`.
Channels, object keys, IDs and event contents are never logged by this profiler.

The 32 MiB per-document limit and two-hour retention limit remain independent.
These counters measure serialized application bytes, before WebSocket compression.
They do not measure mobile data usage. No protocol events are discarded or
coalesced by this change; a category's replacement semantics must be established
before changing delivery guarantees.

## Browser measurements

Every report carries the current connection attempt and a random visit identity.
The server hashes document and session identities. Reports contain only numeric
measurements and enum values, and remain limited to 60 per minute.

| Event | Meaning |
|---|---|
| `navigation` | DNS, connection/TLS, request-to-first-byte, HTML completion and DOM-ready timing from Navigation Timing |
| `resources_ready` | All planned startup assets have completed; aggregate transferred/encoded bytes and last response-end time, without resource URLs |
| `open` / `first_message` | WebSocket open and first frame, measured from that connection attempt |
| `caught_up` | The browser has applied the ordered replay through the server's advertised head |
| `recovery_paint` | Two animation frames after replay completion, provided that the same connection remains ready and the page is visible |
| `ready` | Initial composer appearance plus two frames; includes navigation-relative time and the startup asset summary |
| `network_change` | The browser reports a network estimate change |

`foregroundMs` is measured from the last foreground transition to replay/paint.
`replayBytes` counts decoded event frames processed before caught-up. Paint is a
frame opportunity, not proof that all asynchronous application work has finished.
Asset end, HTML end and navigation-ready times share the navigation time origin;
ordinary `elapsedMs` starts when the diagnostic script runs.

Browser network type, effective type, RTT and downlink estimates are included
when supported. Effective `4g` is a browser quality estimate, not proof of a
cellular connection or carrier. Missing fields mean unavailable. Zero transfer
size can indicate cached content and should be read with encoded size and timing.

## Phone comparison

Use the same phone and page for Wi-Fi and mobile data. Record the chosen network
and approximate time. Repeat foreground reload, return after 60 seconds in the
background, and Wi-Fi-to-cellular switching. Compare per-stage medians and ranges,
joining browser attempts with server buffer profiles. Do not infer a carrier from
the browser's effective type. Synthetic browser throttling verifies recovery
behavior but does not establish carrier performance.
