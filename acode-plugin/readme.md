# Agent Console for Acode

Open a workspace file in Acode by tapping **Edit** in Agent Console. Save in Acode to write changes back to the workspace. No SSH or SFTP setup is required.

## Install once

1. Install Acode 1.13.5 or newer on Android (version code 1011 or newer).
2. Download the Agent Console plugin ZIP from your Agent Console installation.
3. In Acode, open **Plugins → + → Local** and select the ZIP. Alternatively, use **Remote** with its HTTPS download URL.
4. Return to Agent Console and tap **Edit** beside a text file.

Android may ask permission to open Acode. The bridge requires an Acode build with the Intent API. If the plugin reports that Intent support is missing, update Acode.

## Saving

The plugin uses HTTPS with short-lived access scoped to the selected file. Access tokens stay in memory and are never stored in plugin settings. A server revision prevents saves from overwriting changes made elsewhere. If a save reports a conflict, keep the Acode tab open and compare your changes with the workspace version. If access expires, tap **Edit** again to refresh access without replacing the open tab's edits.

Keep Acode open while editing. Bridge tabs are not restored after restarting Acode; save changes before closing the app.

## Build

Package `plugin.json`, `main.js`, and `readme.md` at the root of a ZIP file. No dependencies or JavaScript build step are required.

## API references

- [Acode Intent API](https://docs.acode.app/docs/advanced-apis/intent)
- [Acode EditorFile API](https://docs.acode.app/docs/editor-components/editor-file)
- [Acode plugin template](https://github.com/Acode-Foundation/acode-plugin)

The built-in `acode://plugin/install/<id>` intent installs registry plugins only. This privately hosted ZIP needs the one-time installation above.
