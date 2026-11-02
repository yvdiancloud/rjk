# Local MCP Studio

Local MCP Studio exposes a user-selected project as MCP tools. The Windows client has a native WPF interface and runs the MCP bridge locally. A self-hosted server supplies only HTTPS ingress and an SSH reverse tunnel; project files and MCP tokens stay on the client.

## Custom client and source packages

Version 0.1.14 provides three build outputs:

- `Local MCP Studio-0.1.14-Setup-x64.exe`: Windows installer.
- `Local MCP Studio-0.1.14-Portable.zip`: portable Windows application.
- `Local MCP Studio-0.1.14-Source.zip`: curated client and server source bundle.

Create the source archive with `npm run pack:source`. The packaging script includes the bridge, UI, native client, plugin metadata, generic server templates, and build files. It deliberately excludes local `settings.json`, `server-tunnel-ed25519`, private credentials, generated binaries, dependency folders, and browser-profile design previews.

Client runtime settings and the generated SSH key are stored in the current user's application-data folder. For development, set `WEXRUN_DATA_DIR` to choose a different private location. The source folder is never used as the default data directory.

## How the self-hosted connection works

The MCP service runs on the user's computer. In self-hosted mode, the client opens an SSH reverse tunnel to the user's server. Nginx terminates HTTPS for a hostname chosen by that user, disables request-path logging, and forwards only `/mcp/` traffic to loopback port `43128`. The server does not run MCP tools and does not store a project copy or the user's MCP token.

See [server/README.md](server/README.md) for the generic Debian/Ubuntu-oriented SSH, Nginx, and Certbot setup. The sample Nginx virtual host matches one placeholder hostname and does not claim a default listener; replace the placeholder with a hostname the server owner controls.

The client starts with blank self-hosted server settings. Enter the SSH host, port, username, and HTTPS origin in the app. Use **读取指纹** and verify the displayed SSH host fingerprint from the server console before saving.

## ChatGPT setup

1. Select a local project and permission level in Local MCP Studio.
2. Start the chosen public connection and copy the MCP URL.
3. Create a custom MCP app in ChatGPT and paste the URL.

The full MCP URL contains a bearer token. Treat it as a secret and only share it with trusted MCP clients.

## Permissions and tools

- **Read only**: list, read, search, Git status, and diff.
- **Edit**: adds creating or overwriting files inside the selected project.
- **Developer mode**: adds command execution, long-running task controls, and Git stage/commit.
- Developer mode also opens the REA 6.8.0 MCP catalog (229 tools) over its local stdio interface. External analysis engines remain separate dependencies.

Local MCP file tools stay inside the selected project and do not follow symbolic links. Commands run with the current Windows user's permissions. REA tools can inspect targets named in their arguments and may perform runtime operations; their targets are not limited to the selected project. Use developer mode only with trusted clients and targets.

## Build from source

For source development, install a compatible Node.js version and run:

```powershell
npm ci
npm start
```

The Windows native build requires Windows, .NET Framework 4.8, NSIS 3.x, Node.js 22.23.4+, 24.22.1+, or 26.12.1+, and a separately installed REA 6.8.0 package. Set `LOCALMCP_REA_PACKAGE` if the REA package is not installed in the global npm directory. The first Windows build downloads the pinned Roslyn compiler and official Cloudflare `cloudflared` binary, then verifies the binary's SHA-256 before use.

```powershell
npm run build:win
npm run pack:source
```

Artifacts go in `dist/`. The installer and native executable are unsigned, so Windows SmartScreen may show a prompt. The source bundle includes `CLOUDFLARED-LICENSE.txt` and the runtime downloads its binary during the build; it excludes the binary from the source archive.
