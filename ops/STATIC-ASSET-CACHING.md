# Startup assets

Full and Lite builds use `startup-preloads.mjs` to discover static imports of the initial shell. The generated module preloads let browsers request these dependencies from the HTML instead of discovering each layer after downloading the previous one. Conversation and other dynamic imports retain their existing scheduler, so they do not compete with the shell download.

Patched Desktop bundles can keep their original filenames even when their contents change. Serve those mutable URLs with revalidation. A filename that resembles a content hash does not establish that the patched file is immutable.

For public deployments, create a distinct static directory for every release. After building, apply `withVersionedAssets(html, releaseName)` to the HTML in that release. This changes asset URLs and the startup resource inventory to `/codex-static/<releaseName>/assets/...` or `/codex-static/<releaseName>/lite/assets/...`. Relative module imports continue inside the same release. Application routes and API URLs retain their existing paths.

Run `npm run build` followed by `npm run build:release -- RELEASE OUTPUT_DIRECTORY`. The output directory must not exist. This packages both entries, rewrites their asset addresses and inventories, compresses startup resources, and writes a SHA-256 file manifest next to the release. Publish that verified directory and switch the entry HTML only after acceptance. Preserve the existing runtime's private configuration separately.

Serve this namespace from the parent release directory with the existing authentication check and `Cache-Control: private, max-age=31536000, immutable`. Do not overwrite published files in that namespace. Keep referenced releases available while pages or caches can still reference them. HTML, APIs and mutable asset paths must continue to revalidate; apply the immutable policy only to the versioned namespace.

Generate Brotli and gzip sidecars from the exact file being published and verify their decompressed bytes before activation. Changing a compressed representation must not change the uncompressed JavaScript or CSS.

Validate cold and repeat navigation in a browser with HTTP caching enabled. Playwright HTTP request routing disables the browser cache, so candidate tests that substitute HTML are functional checks, not repeat-navigation performance measurements. Record resource transfer sizes and confirm authentication separately.
