[日本語](./README.md)

# cc-remote-mcp

A remote MCP server, plus a resident client for each PC, that lets Claude (claude.ai chats and projects) start and stop `claude rc` (Claude Code Remote Control) and interactive sessions with an initial prompt on your own PC, and send input to those interactive sessions.

```
claude.ai ──MCP(OAuth)──▶ <MCP host>/mcp ─┐  Cloudflare Workers
                                          ├─ Durable Object (DeviceHub)
Client on each PC ──WebSocket(device token)──▶ <link host>/connect ─┘
```

Hostnames (for example `cc-remote-mcp.example.com` and `link.cc-remote-mcp.example.com`) and Cloudflare Access values are not kept in the repository; they are filled in at deploy time ([docs/setup.md](./docs/setup.md)).

- The PC accepts no inbound connections. The client keeps a WebSocket open to the Worker, and commands arrive over it.
- The client can do only seven things: list, stop and start rc; list directories; start, send input to and stop interactive sessions. It runs no arbitrary commands.
- Listing and starting work only inside `ALLOWED_ROOTS`. `BLOCKED_DIRS` and places where credentials are kept (such as `~/.ssh`) are always excluded.

Note: the detailed docs under `docs/` are written in Japanese.

## MCP tools

| Tool | What it does |
| --- | --- |
| `list_devices` | Registered devices, and whether each is connected |
| `list_rc_sessions` | The rc and interactive sessions this client started on the device |
| `stop_rc_session` | Stop an rc or interactive session (equivalent to Ctrl+C) |
| `list_directories` | List the subdirectories directly under a directory on the device (omit the path to get the allowed roots) |
| `start_rc_session` | Start `claude remote-control` in a directory on the device |
| `start_session` | Start an interactive session with an initial prompt in a directory on the device (`claude --remote-control`; inside tmux on macOS / Linux, inside a pseudo terminal on Windows) |
| `send_input` | Send text or keys to an interactive session |

On macOS / Linux, interactive sessions run inside tmux. On macOS, and on Linux started by hand (without systemd), they survive a client restart; under Linux systemd (`KillMode=mixed`) they stop together with the service. On Windows they run inside a pseudo terminal (ConPTY) that the client opens, so they end when the client stops, crashes or restarts (the conversation can be resumed in a terminal with `claude --resume`). For details, see [docs/interactive/](./docs/interactive/README.md).

## Trust boundaries and assumptions

Before deploying, check whom you will be trusting and what becomes possible on your PC.

- **Who can operate your PC**: a person who passes Cloudflare Access on the MCP host and whose email address matches `ALLOWED_EMAIL`, and the MCP client that calls tools on their behalf (such as claude.ai). Within the allowed roots of a registered PC, they can start and stop `claude remote-control`, and start interactive sessions with any prompt and send them input. In effect, this is the same as being able to run Claude Code (which can also run commands) on that PC.
- **What the client restricts**: it accepts only the seven operations, and runs no shell or arbitrary commands. Where it starts things is limited, via `resolveDir`, to inside `ALLOWED_ROOTS` (excluding `BLOCKED_DIRS` and places where credentials are kept). The client's own settings (such as the device token) are removed from the environment variables passed to child processes. At most `MAX_SESSIONS` sessions can run at the same time. tmux runs on a dedicated socket (`-L cc-remote-mcp`).
- **The restriction stops at where things start**: what the started Claude Code can touch, and where it asks for confirmation, is decided by that PC's own Claude Code permission settings and the permission mode at launch. The only selectable permission modes are `default` / `acceptEdits` / `plan` / `auto`; flags that skip confirmation (such as `--dangerously-skip-permissions`) are never passed.
- **If a device token leaks**, someone can connect to the Worker pretending to be that PC. The real connection is closed, and the impostor receives the commands addressed to that PC (including prompts, input and paths) and can return fake results. A leaked token cannot be used to operate the PC or to send commands to other devices. To revoke it, remove it from `DEVICE_KEYS` and run `secret put` ([docs/auth/](./docs/auth/README.md)).
- **Anyone with access to the Cloudflare account** can change the Worker's code and secrets, so they can do everything above (prompts and input also pass through the Worker). What the Worker itself writes to its logs is the operation name, device name, duration, result type and the like; it does not log the contents of prompts or input. The client's logs on the PC likewise record only the length of prompts and input, not their contents.
- **The receiver of the Discord webhook** (if you set one) gets the start and stop of rc and interactive sessions (time, device name, location; for starts, also the status) and the email addresses that were rejected. The contents of prompts and input are not sent.
- This project is not an official Anthropic tool and is not affiliated with Anthropic.

## Setup

For the steps, see [docs/setup.md](./docs/setup.md). For the design and implementation, see [docs/README.md](./docs/README.md).

## Development

```sh
bun install
bun run typecheck
bun test
bun run dev        # wrangler dev (with DEV_BYPASS_ACCESS=1, Access can be skipped on localhost. --local-upstream keeps the Host as localhost)
bun run client     # run the client locally (reads client/.env. For another config file, use `--env <path>`)
bun run cf-typegen # regenerate worker-configuration.d.ts after changing wrangler.jsonc
bun run deploy     # deploy with the production values (CC_REMOTE_MCP_* in .env.local) filled in
```

For the secrets used by `bun run dev`, copy `.dev.vars.example` to `.dev.vars` and fill it in (`ALLOWED_EMAIL`, `DEVICE_KEYS`, `DEV_BYPASS_ACCESS`, `DISCORD_WEBHOOK_URL`. Do not commit `.dev.vars`).

`src/` runs on Cloudflare Workers, so it does not use Bun-specific APIs. `client/` and `scripts/` run on Bun.

## License

MIT ([LICENSE](LICENSE))
