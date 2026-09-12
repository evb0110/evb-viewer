# Chrome plugin trust-path repair handoff

Date: 2026-08-31

This is the handoff for a second Mac whose native `@Chrome` control fails after a ChatGPT or bundled Browser plugin update.

## What was found

The failure was in Codex's `node_repl` trusted-module loader, not in Chrome's user permissions, the Chrome profile, or the ChatGPT extension. The misleading error was:

```text
Trusted RPC dependency must resolve within a configured trusted code path:
file:///.../.codex/plugins/cache/openai-bundled/browser/<version>/scripts/browser-service.mjs
```

The loader starts a trusted worker and checks every local JavaScript import against `NODE_REPL_TRUSTED_CODE_PATHS`. After a plugin update, the configured Browser service version and the trusted worker roots drifted apart. A broad writable root such as `/Users/<user>/.codex` was rejected or stripped. The exact versioned `browser/scripts` and `chrome/scripts` directories were accepted.

Chrome itself was healthy in the incident. The extension and native host checks passed. The failure happened before Codex contacted Chrome.

## The matching old tasks

- `01a020d1-7f52-7811-89d3-5e8661618012`, `FM: Check OSS trial extension`, 2026-08-20. This is the initial diagnosis. It found a missing `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S` entry in `[mcp_servers.node_repl.env]` and a stale hash in shell policy. That was useful evidence, but the proposed hash-only repair was not verified.
- `01a020d4-d292-73d3-b4a2-35c3cc3e3313`, `SH: Check OSS trial extension`, 2026-08-20. This contains the working one-off repair. The app had moved to Browser bundle `26.818.22352`; the broad trust root was rejected, a project override was ignored by the resumed desktop task, and a reversible service-copy symlink made native Chrome work.
- `01a04521-711d-70e3-a87c-a5bbaf223f66`, `EDITORUM: Triage journal domain errors`, 2026-08-28. This records the same failure recurring with Browser bundle `26.820.60940` while managed configuration still allowed only `26.818.41509`.

The raw records are on the original Mac in [the diagnosis rollout](/Users/evb/.codex/archived_sessions/rollout-2026-08-21T00-16-35-01a020d1-7f52-7811-89d3-5e8661618012.jsonl) and [the repair rollout](/Users/evb/.codex/archived_sessions/rollout-2026-08-21T00-20-13-01a020d4-d292-73d3-b4a2-35c3cc3e3313.jsonl).

## Durable repair used on this Mac

The current machine no longer relies on the one-off symlink. It has:

- exact versioned trust paths in `/Users/evb/.codex/config.toml`, under `[mcp_servers.node_repl.env]` and the shell policy copy;
- the Browser service path set to the matching `browser/<version>/scripts/browser-service.mjs` file;
- the stale `/etc/codex/managed_config.toml` override disabled recoverably, with backups retained;
- `/Users/evb/.codex/bin/sync-codex-browser-trust.py`, which verifies the signed ChatGPT app, compares cached Browser and Chrome scripts byte-for-byte with the app bundle, updates the versioned config atomically, and refuses to proceed while a stale managed override is active;
- `/Users/evb/Library/LaunchAgents/com.evb.codex-browser-trust-sync.plist`, which runs the checker at login, every five minutes, and when the app bundle, config, or plugin cache changes.

The source of that logic is [the sync script](/Users/evb/.codex/bin/sync-codex-browser-trust.py:46). The cache comparison is at [lines 88-104](/Users/evb/.codex/bin/sync-codex-browser-trust.py:88), config generation at [lines 151-169](/Users/evb/.codex/bin/sync-codex-browser-trust.py:151), and the managed-config guard at [lines 196-215](/Users/evb/.codex/bin/sync-codex-browser-trust.py:196). The current check returned:

```text
ok: browser trust matches ChatGPT 26.825.51511
```

## Portable repair recipe

Use the other Mac's actual paths and current bundle version. Do not copy the old version numbers or hash values.

1. Check the app and plugin versions.

   ```sh
   app_root="/Applications/ChatGPT.app"
   user_codex_dir="/Users/<user>/.codex"
   app_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_root/Contents/Info.plist")
   plugin_root="$user_codex_dir/plugins/cache/openai-bundled"
   printf 'ChatGPT=%s\n' "$app_version"
   find "$plugin_root/browser" "$plugin_root/chrome" -maxdepth 2 -type d -name "$app_version" -print
   ```

2. Inspect `/etc/codex/managed_config.toml` and the user's `config.toml`. If the managed file contains `NODE_REPL_TRUSTED_CODE_PATHS` for an older plugin version, preserve it and disable it only if the machine is personally managed. On a managed machine, involve the administrator instead.

3. Under `[mcp_servers.node_repl.env]`, set these values from the current version:

   ```toml
   NODE_REPL_TRUSTED_CODE_PATHS = "/Users/<user>/.codex/plugins/cache/openai-bundled/browser/<version>/scripts:/Users/<user>/.codex/plugins/cache/openai-bundled/chrome/<version>/scripts:/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules"
   BROWSER_USE_CODEX_APP_VERSION = "<version>"
   NODE_REPL_TRUSTED_SERVICES = "{\"browser\":\"/Users/<user>/.codex/plugins/cache/openai-bundled/browser/<version>/scripts/browser-service.mjs\",\"sky\":\"@oai/sky/service\"}"
   ```

   Keep the same exact trust-path value in `[shell_environment_policy.set]` if that machine uses it for shell-launched diagnostics. The important distinction is that the trust path must also be present in the `node_repl` MCP environment, not only in shell policy.

4. Verify the cached scripts against the signed app bundle before trusting them. The current sync script's rule is strict: the file lists, sizes, and SHA-256 hashes for both `browser/scripts` and `chrome/scripts` must match the corresponding files under `ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins`.

5. Fully quit and relaunch ChatGPT after changing the MCP environment. A JavaScript-kernel reset alone does not refresh the MCP server's frozen environment. Then run the matching bundled diagnostics from the Chrome plugin directory:

   ```sh
   scripts/chrome-is-running.js --browser chrome --check
   scripts/installed-browsers.js --json
   scripts/check-extension-installed.js --browser chrome --json
   scripts/check-native-host-manifest.js --browser chrome --json
   ```

6. Test the actual native path, not just the four diagnostics. The expected sequence is `setupBrowserRuntime()`, `agent.browsers.get("chrome")`, then `chrome.user.openTabs()`. If that fails with the same trusted-path error, inspect the environment of the newly launched `node_repl` process and confirm it received the current exact paths.

## Secondary hash finding

The first diagnosis found an old `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S` value and the current `browser-client.mjs` hash. On older builds that explicitly expose this variable, put the current hash in `[mcp_servers.node_repl.env]`, not only in shell policy. On the later `26.818.22352` build, the binary no longer appeared to consume that variable. The verified fix was the trusted service path, so do not stop after changing the hash.

## Historical one-off fallback

The August 20 task made Chrome work by copying the versioned Browser service into the app's already trusted runtime directory and replacing the cache copy with a symlink. It backed up the original file first and compared the backup and trusted copy's SHA-256 values. This was reversible, but it is version-specific and can be invalidated by the next app update. Use the version-aware config and sync approach first. If the desktop app still ignores correct config, reproduce that behavior, preserve a byte-for-byte backup, and treat the symlink as a temporary compatibility shim rather than the permanent repair.

Do not substitute Claude Code's `chrome-debug` or a different browser tool. That is a separate native-messaging stack and does not diagnose Codex's `node_repl` trust loader.

## Local primary sources

- [Bundled Browser bootstrap troubleshooting](/Users/evb/.codex/plugins/cache/openai-bundled/browser/26.825.51511/docs/bootstrap-troubleshooting.md)
- [Bundled Chrome troubleshooting](/Users/evb/.codex/plugins/cache/openai-bundled/browser/26.825.51511/docs/chrome-troubleshooting.md)
- [Current trust-sync LaunchAgent](/Users/evb/Library/LaunchAgents/com.evb.codex-browser-trust-sync.plist)
- [Current user config, `node_repl` block](/Users/evb/.codex/config.toml:181)
