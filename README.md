# thesystem

Install it and you have a dev shop.

## Quick Start

```bash
brew tap tjamescouch/thesystem
brew install thesystem
thesystem init
thesystem start
```

## What You Get

A complete multi-agent development environment running in an isolated Lima VM:

- **AgentChat server** — WebSocket relay for agent communication
- **Dashboard** — real-time web UI at http://localhost:3000
- **Agent swarm** — N sandboxed AI agents in Podman containers
- **Agent-sync** — automatic GitHub PR creation from agent work

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
thesystem init          Create thesystem.yaml with defaults
thesystem start         Boot Lima VM and all services
thesystem stop          Graceful shutdown (services + VM)
thesystem status        Show component status table
thesystem destroy       Delete VM (rebuilds from scratch on next start)
thesystem doctor        Check prerequisites and system health
thesystem config        Show resolved configuration
thesystem logs [svc]    Tail logs (server, dashboard, swarm)
thesystem version       Show version
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

Environment variables can be used with `${VAR}` syntax. Secrets should live in env vars, never in the config file.

## Architecture

```
┌──── Your Mac ──────────────────────────────────────────────┐
│                                                             │
│  thesystem CLI (host-side, manages VM lifecycle)            │
│  Your Claude Code sessions (unmanaged, trusted)             │
│  API keys live here and ONLY here                           │
│                                                             │
│  ┌══ Lima VM "thesystem" ════════════════════════════════┐  │
│  ║                                                        ║  │
│  ║  agentchat-server :6667  (server mode only)           ║  │
│  ║  agentdash :3000  (server mode only)        ║  │
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
| Your Mac | CRITICAL | API keys, unmanaged agents, you |
| Lima VM | Expendable | Managed agents, sandboxed, disposable |
| Remote router | Can be compromised | Shared relay, no secrets stored |

The VM protects your Mac FROM the managed agents. If a managed agent goes rogue, it's trapped in a Podman container inside a VM. Your host machine, API keys, and source code are safe.

### Security Notes

- In **server mode** with public access, do not use the VM as a development environment. The server accepts inbound connections — keep the attack surface minimal.
- API keys are never passed into the VM. Use agentauth proxy for key injection.
- Agent containers have no network access except to the AgentChat server and LLM endpoint.
- `~/dev` is mounted **read-only**. Agents write to their own workspace inside the container.

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
  VM ... running
  VM node v20.18.0

[thesystem] Diagnostics complete.
```

Common issues:
- **VM won't start**: Check `limactl list`. Delete and recreate with `thesystem destroy && thesystem start`.
- **Port conflict**: Another process using 6667 or 3000. Change ports in `thesystem.yaml`.
- **Slow first start**: First run downloads Ubuntu image and installs packages. Subsequent starts are fast.

## License

MIT
