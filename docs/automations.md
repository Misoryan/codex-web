# Local Scheduled Tasks

The Web bridge runs the native automation scheduler when the server starts. It
does not wait for a browser to become visible or publish local capabilities.
The scheduler checks due tasks every 30 seconds and retries after the local
app-server connection recovers.

For a heartbeat, the server first checks the target thread's activity and pending
approval/input state. It then resumes the idle thread to read its persisted
collaboration mode, model and reasoning effort. Unsaved composer model choices
do not replace the saved settings used by a scheduled run. The existing
permission resolution, model availability checks, due-time persistence and
per-thread exclusion remain in the native execution path.

Full and Lite both retain the native heartbeat UI component. The component
publishes current UI eligibility and hydrates scheduled conversations, but its
absence no longer prevents the server from starting a heartbeat.

The host computer and bridge process must remain running. This change does not
wake a sleeping computer. Overdue tasks use the native catch-up behavior; busy
threads are deferred rather than interrupted.

## Validation

`node scripts/test-automation-scheduler.mjs` runs the patched native scheduler and
heartbeat pipeline with isolated storage and app-server transport fixtures. It
covers headless startup, due times, saved settings, permissions, retries, busy
threads and duplicate prevention. `npm run test:desktop` includes this test.

After deploying the backend, check for `Headless automation scheduler started`
in the new process log. A backend file update is not active until that process
has restarted. Activate only when local and connected remote conversations are
idle; do not rerun real scheduled business tasks as a deployment test.
