# Client capabilities

Clipboard text belongs to the device viewing the page. The renderer's clipboard service uses the current browser's Clipboard API for copying text, links, paths and reading pasted text. It never delegates these operations to the remote app host. Rich content and image copying also use the browser Clipboard API. Permission failures remain failures and are reported for the current page or client.

The browser preload detects the viewing device's platform from browser-provided information. A client exposing `codexElectron` is identified as an external Electron wrapper. The shim does not claim a macOS ARM64 build or an installed native Codex Desktop application. `windowType` remains the app-host transport discriminator; it does not grant native device capabilities.

Native Desktop file/link drag methods are omitted so that DOM drag events use browser behavior. The wrapper's explicit local-file opening capability remains separate from server-side workspace paths.

Clipboard APIs require HTTPS, or an HTTP loopback origin recognized as secure by the browser. Browsers and Electron enforce their own focus and permission rules. The application does not bypass those rules or send clipboard data to the server when access is denied.

`node scripts/test-client-capabilities.cjs` exercises real browser clipboard writes and reads, asynchronous text, permission denial, remote-service isolation and platform profiles. Desktop acceptance should additionally click the actual copy controls in Full and Lite using an isolated conversation and verify the viewing device's clipboard.
