# Acode editing

The file viewer's **Edit** link opens the selected text file in Acode on Android. Install the private bridge plugin once from `/acode-setup`. Acode provides the editor; no SSH or SFTP connection is configured on the phone.

## Server setup

1. Build the plugin: `python3 scripts/package-acode.py`.
2. Set `AGENT_CONSOLE_ACODE_URL` to the HTTPS origin for the dedicated bridge port, and optionally `AGENT_CONSOLE_ACODE_PORT` (default `7076`). Both can live in `~/.config/agent-console/env`.
3. Expose only that bridge port through HTTPS. In Coder, share port `7076` publicly and keep the main Console port `7070` owner-only. The bridge binds to localhost and serves only the plugin ZIP and capability-protected exchange/read/save APIs. Never add the bridge host to `AGENT_CONSOLE_PUBLIC_HOST`.
4. Queue `bin/agent-console restart-when-idle`.

If no bridge URL is configured, Edit reports that editing is unavailable. The main Console stays private. Acode makes native requests without a Coder browser cookie; its dedicated URL must reach the bridge without a Coder login redirect.

### Coder proxy CORS

Coder v2.38's default `simple` template CORS policy intercepts browser preflights and strips the bridge's response headers. Node HTTP probes can pass while Acode reports `Failed to fetch`. The deployed Caddy wildcard site applies [a bridge-only header exception](acode-caddy.caddy) to the two bridge API paths and known local WebView origins. It answers their preflights before Coder and restores response headers after proxying. This does not change Console authentication or the template-wide CORS policy.

Validate the public route with `ACODE_PUBLIC_TEST_URL=https://YOUR-BRIDGE-HOST rtk test node test/acode-public-cors.ts`. This uses Chromium's actual preflight enforcement, not a Node-only fetch. If the bridge hostname changes, update the Caddy matcher too.

## Phone setup

Open `/acode-setup`, download the plugin ZIP, then use **Acode 1.13.5 or newer → Plugins → + → Local** to install it. Return to Console and tap **Edit**. Android may ask whether to open Acode. The private ZIP cannot be installed automatically through Acode's registry-only plugin installation intent.

## Access and saves

Opening a text file prepares a one-use, 60-second ticket. While the viewer is visible, the link refreshes before expiry so tapping Edit remains a direct user gesture. The plugin exchanges the ticket for an eight-hour bearer grant to that single canonical file. Grants remain in server memory; a server restart revokes them. Tokens remain in plugin memory and are not persisted in restored tabs.

The bridge uses the viewer's path and credential exclusions and accepts only regular UTF-8 text up to 1 MiB. Saves compare a SHA-256 revision; stale saves return `409` and preserve the Acode buffer. A same-directory temporary file is synced and renamed into place, preserving permission bits. Hard-linked files and changed symlink targets are rejected. External tools do not share the bridge's locks; final revision and inode checks narrow the unavoidable race with another OS process. The plugin never silently forces an overwrite. If access expires, tapping Edit refreshes the existing tab's grant while preserving unsaved edits. Save before restarting Acode: bridge tabs are not restored after an app restart.

Returning to the Console refreshes the preview. Images and empty folder views have no Edit link. Code and bridge assets remain outside the initial chat load.

## Validation

`npm run test:acode` checks capability expiry/replay, file boundaries, save conflicts, plugin save behavior, app launch URLs and the isolated bridge listener. `npm run test:files` covers the existing viewer. Mock servers disable the public bridge unless `AGENT_CONSOLE_ACODE_TEST=1`, preventing scratch tests from claiming the live bridge port. Actual Android app switching requires a device with Acode and the plugin installed.
