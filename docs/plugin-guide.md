# Plugin guide

This guide covers installing, managing, configuring, and granting permissions for T3 Patcher plugins as a user.

For developers creating or building new plugins, refer to the [Plugin authoring guide](plugin-authoring.md).

## Plugin location and storage

Plugins are stored on disk in the patcher home directory:

- Default location: `<USERPROFILE>/.t3-patcher/plugins/<id>/` (Windows) or `~/.t3-patcher/plugins/<id>/`.
- Override location: Set the `T3P_HOME` environment variable to use a custom directory.
- Each plugin directory contains:
  - `plugin.json`: The manifest describing the plugin ID, version, API tier, declared permissions, and entry points.
  - `dist/renderer.js` (or other relative path declared in the manifest): The bundled JavaScript code executed by the patcher runtime.

Plugin configuration and permission grants are recorded in `<T3P_HOME>/.t3-patcher/state.json`.

## Managing plugins with the CLI

The `t3p` CLI provides commands to inspect, enable, disable, and configure plugins.

### Listing plugins

Run `t3p plugins` to view all installed plugins:

```sh
t3p plugins
```

The output displays:
- Status: `on` (enabled) or `off` (disabled).
- Plugin identifier and version (e.g. `provider-limits@1.0.0`).
- Validation state (e.g. `invalid: ...` if the manifest is malformed).
- Declared permissions requested by the manifest.
- Granted permissions currently approved in `state.json`.

For automated scripting, pass `--json`:

```sh
t3p plugins --json
```

### Enabling and disabling plugins

To enable a plugin:

```sh
t3p enable <id>
```

To disable a plugin:

```sh
t3p disable <id>
```

Changes take effect when T3 Code starts. If T3 Code is running, restart the application to apply the change.

### Safe mode

If a plugin causes rendering issues or application crashes, you can bypass all plugins and patches on the next startup:

```sh
t3p safe
```

This writes a one-shot marker file at `<T3P_HOME>/.t3-patcher/safe-mode`. The next application start will launch the stock T3 Code application directly without loading any plugins, patches, or runtime hooks, and will automatically remove the marker.

To cancel a pending safe-mode request before launching:

```sh
t3p safe --off
```

You can also run in safe mode at any time using the environment variable `T3P_SAFE=1` or passing `--t3p-safe` on the application command line.

## In-app management (Settings page)

When T3 Patcher is active, a dedicated settings page is available inside T3 Code:

1. Open **Settings** in T3 Code.
2. Select **Plugins** under the More section in the settings navigation (or navigate to `#/settings/plugins`).
3. Each installed plugin is displayed as a card showing:
   - Name and description.
   - Version, author, and API stability tier.
   - Load status (`started`, `inactive`, or `failed`).
   - An on/off toggle switch.

Plugins that declare high-privilege permissions (`main`, `patches`, or `spawn`) cannot be toggled from the web UI; they must be enabled via `t3p enable <id>` from the command line.

### Configuring plugin settings

Plugins that declare configuration schemas via `t3.settings.define()` automatically render interactive controls within their card on the Plugins settings page:

- Boolean switches.
- Text input fields.
- Number inputs (with min/max range enforcement).
- Enum dropdown selectors.
- A **Reset** action to restore default values.

Setting changes are saved immediately to `<T3P_HOME>/.t3-patcher/state.json` and persist across application restarts.

## Permissions system

T3 Patcher employs an explicit permission model. A plugin receives only the intersection of what it **declares** in `plugin.json` and what the user **grants** in `state.json`:

$$\text{Effective Permissions} = \text{Declared} \cap \text{Granted}$$

If a plugin declares a permission but the user has not granted it, calling the associated API method rejects with a `T3PermissionError`.

### Permission reference

| Permission | Scope syntax | Description |
|---|---|---|
| `rpc` | Bare name | Allows making calls, streams, and HTTP requests to the local T3 Code server via `t3.rpc`. |
| `main` | Bare name | Allows executing Node.js code in Electron's main process via a `main` entry. |
| `patches` | Bare name | Allows applying tier 3 find-and-replace text patches to client JavaScript chunks. |
| `fs.read` | `--root DIR` | Allows reading file contents under specified root paths up to 4 MiB per call via `t3.native.fsRead`. |
| `sqlite.read` | `--root DIR` | Allows executing read-only SQL SELECT queries against `.sqlite` or `.db` files under specified roots via `t3.native.sqliteQuery`. |
| `log.tail` | `--root DIR` | Allows reading and streaming lines from log files under specified roots via `t3.native.logTail`. |
| `spawn` | `--allow EXE` | Allows executing specific allowlisted executable binaries without a shell via `t3.native.spawn`. |

### Granting permissions

Use `t3p grant` to approve permissions for a plugin:

```sh
# Grant server RPC access
t3p grant com.example.plugin rpc

# Grant filesystem read access under a specific directory (~ expands to T3P_HOME)
t3p grant com.example.plugin fs.read --root ~/.t3/caches

# Grant SQLite read access to the T3 data directory
t3p grant com.example.plugin sqlite.read --root ~/.t3

# Grant log tailing access
t3p grant com.example.plugin log.tail --root ~/.t3/userdata/logs

# Grant permission to spawn a specific tool
t3p grant com.example.plugin spawn --allow "C:/Tools/git.exe"
```

Scope rules:
- Paths must be absolute or begin with `~/` (which resolves to `<T3P_HOME>`).
- Device namespaces (`\\.\`, `\\?\`), UNC network shares, relative dot segments (`.` or `..`), and NTFS alternate data streams (`::$DATA`) are rejected.
- You can specify multiple `--root` or `--allow` flags in a single command.

### Revoking permissions

Use `t3p revoke` to remove a granted permission:

```sh
t3p revoke com.example.plugin fs.read
```

### Security considerations

- **Renderer execution**: Renderer plugins run within the main JavaScript context of the `t3code://app` protocol. In this context, code shares memory with the application UI and has access to the local environment bearer token. Renderer-side permissions serve as user consent markers rather than isolated process boundaries.
- **Main process and patches**: Plugins granted `main` or `patches` run with full Node.js and Electron system privileges.
- **Process spawning**: Granting interpreters such as `cmd.exe`, `powershell.exe`, or `node.exe` effectively grants arbitrary command execution. Only grant `spawn` for dedicated tools.

For a full analysis of the security architecture, see [Security model](security.md).

## Plugin development linking

If you are developing a plugin locally, you can link its development folder directly into the patcher without copying files manually:

```sh
t3p dev path/to/my-plugin
```

This operation:
1. Validates the `plugin.json` manifest in the target directory.
2. Creates a directory junction (symlink on Unix) at `<T3P_HOME>/.t3-patcher/plugins/<id>` pointing to the source directory.
3. Enables the plugin in `state.json`.
4. Writes the `<T3P_HOME>/.t3-patcher/dev-mode` marker, activating the hot-reload file watcher.

While development mode is active, any rebuild of the plugin's `dist/renderer.js` automatically reloads the plugin in the running application.

To unlink a development plugin and remove the hot reload marker:

```sh
t3p dev --unlink <id>
```
