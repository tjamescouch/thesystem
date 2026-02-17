# thesystem

Install it and you have a dev shop.

## Quick Start

```bash
brew tap tjamescouch/thesystem
brew install thesystem
thesystem init

# Store API keys in macOS Keychain
thesystem keys set anthropic sk-ant-...

# Start the agentauth proxy (reads from Keychain, required for swarm)
thesystem agentauth start &

# Boot the VM and all services
thesystem start
```

## What You Get

A complete multi-agent development environment running in an isolated Lima VM:

- **AgentChat server** — WebSocket relay for agent communication
- **Dashboard** — real-time web UI at http://localhost:3000
- **Agent swarm** — N AI agents managed by agentctl-swarm in Podman containers
- **agentauth proxy** — API key proxy on the host; agents never see real keys

One command up, one command down. The VM is disposable — nuke it and rebuild from scratch.

## Modes

### Server Mode (default)

Runs a full node: router + workers. Self-contained, no cloud dependency.

```yaml
mode: server
```

Your AgentChat server runs locally. Other instances can connect to you. Dashboard is available at localhost. This is the decentralized path — every instance is a node.

### Client Mode

Workers only. Connects to an existing router.

```yaml
mode: client
client:
  remote: wss://agentchat-server.fly.dev
```

Your agents connect outbound to someone else's server. Lighter footprint, but you depend on their uptime.

## Commands

```
thesystem init                    Create thesystem.yaml with defaults
thesystem start                   Boot Lima VM and all services
thesystem stop                    Graceful shutdown (services + VM)
thesystem status                  Show component status table
thesystem destroy                 Delete VM (rebuilds from scratch on next start)
thesystem doctor                  Check prerequisites and system health
thesystem config                  Show resolved configuration
thesystem logs [svc]              Tail logs (server, dashboard, swarm)
thesystem version                 Show version
thesystem reinstall               Reinstall all components inside the VM
thesystem keys set <provider> <key>   Store API key in macOS Keychain
thesystem keys get <provider>         Read API key from macOS Keychain
thesystem agentauth [start]       Start the host-side agentauth proxy
```

## Configuration

`thesystem init` creates `thesystem.yaml` in the current directory:

```yaml
mode: server

server:
  port: 6667
  dashboard: 3000
  allowlist: true

client:
  remote: wss://agentchat-server.fly.dev

swarm:
  agents: 2
  backend: claude

vm:
  cpus: 4
  memory: 8GiB
  disk: 40GiB
  mount: ~/dev

channels:
  - "#general"
  - "#agents"
```

Environment variables can be substituted with `${VAR}` syntax. Secrets never go in the config file — use `thesystem keys set` to store them in macOS Keychain.

## API Keys & agentauth

Secrets never leave the host machine. The agentauth proxy reads keys from macOS Keychain and forwards authenticated requests to LLM providers. Agents inside the VM receive `ANTHROPIC_BASE_URL=http://host.lima.internal:9999/anthropic` and never see a real key.

```bash
# Store keys (one-time setup)
thesystem keys set anthropic sk-ant-...
thesystem keys set openai sk-...

# Start the proxy (must be running before `thesystem start`)
thesystem agentauth start
```

The swarm will not start if the agentauth proxy is not healthy. This is enforced — there is no env-var fallback.

## Architecture

```
┌──── Your Mac ──────────────────────────────────────────────┐
│                                                             │
│  thesystem CLI (host-side, manages VM lifecycle)            │
│  agentauth proxy :9999 (reads Keychain, never forwards keys)│
│  Your Claude Code sessions (unmanaged, trusted)             │
│                                                             │
│  ┌══ Lima VM "thesystem" ════════════════════════════════┐  │
│  ║                                                        ║  │
│  ║  agentchat-server :6667  (server mode only)           ║  │
│  ║  agentdash :3000         (server mode only)           ║  │
│  ║                                                        ║  │
│  ║  agentctl-swarm                                        ║  │
│  ║    ├── Agent 0 (Podman container)                      ║  │
│  ║    ├── Agent 1 (Podman container)                      ║  │
│  ║    └── Agent N (Podman container)                      ║  │
│  ║                                                        ║  │
│  ║  ~/dev mounted read-only from host                     ║  │
│  ╚════════════════════════════════════════════════════════╝  │
│                                                             │
│  localhost:6667 ← connect your Claude Code here             │
│  localhost:3000 ← dashboard in your browser                 │
└─────────────────────────────────────────────────────────────┘
```

### Trust Model

| Zone | Trust Level | Contains |
|------|-------------|----------|
| Your Mac | CRITICAL | API keys (Keychain), agentauth proxy, you |
| Lima VM | Expendable | Managed agents, sandboxed, disposable |
| Remote router | Can be compromised | Shared relay, no secrets stored |

The VM protects your Mac from the managed agents. If a managed agent goes rogue, it's trapped in a Podman container inside a VM. Your host machine, API keys, and source code are safe.

### Security Notes

- API keys are stored in **macOS Keychain** and never passed into the VM.
- The agentauth proxy listens on `127.0.0.1` only. Agents route through it via `host.lima.internal`.
- Swarm startup is blocked unless the agentauth proxy is healthy — no silent env-var fallback.
- `~/dev` is mounted **read-only**. Agents write to their own workspace inside the container.
- In **server mode** with public access, keep the attack surface minimal — the server accepts inbound connections.

## Prerequisites

- macOS (Apple Silicon or Intel)
- [Homebrew](https://brew.sh)
- Node.js >= 20
- [Lima](https://lima-vm.io) (`brew install lima`)

## Troubleshooting

Run `thesystem doctor` to check your setup:

```
$ thesystem doctor
[thesystem] Running diagnostics...

  Node.js 22.0.0 ... ok
  limactl ... ok
  thesystem.yaml ... ok (mode: server)
  API auth ... ok (no secrets in env)
  VM ... running
  VM node v20.18.0
  Swarm ... running (PID 1234)

[thesystem] Diagnostics complete.
```

Common issues:
- **Swarm won't start**: Ensure `thesystem agentauth start` is running. Check with `curl http://localhost:9999/agentauth/health`.
- **VM won't start**: Check `limactl list`. Delete and recreate with `thesystem destroy && thesystem start`.
- **Port conflict**: Another process using 6667 or 3000. Change ports in `thesystem.yaml`.
- **Slow first start**: First run downloads Ubuntu image and installs packages. Subsequent starts are fast.
- **Components out of date**: Run `thesystem reinstall` to force a fresh install inside the VM.

## License

MIT
