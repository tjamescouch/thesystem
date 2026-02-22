# thesystem

<img width="280" height="277" alt="Screenshot 2026-02-22 at 1 46 26 PM" src="https://github.com/user-attachments/assets/a1f9e22c-ec58-41f9-aa7c-363f3b2656f0" />

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![GitHub all releases](https://img.shields.io/github/downloads/tjamescouch/thesystem/total)
![v0.2.0](https://img.shields.io/github/downloads/tjamescouch/thesystem/v0.2.0/total)

Install it and you have a dev shop.

## Quick Start

```bash
brew tap tjamescouch/thesystem
brew install thesystem
thesystem init

# Store API keys in macOS Keychain (one-time setup)
thesystem keys set anthropic sk-ant-...
thesystem keys set openai sk-...
thesystem keys set google AIzaSy...     # Added: Gemini/Google Cloud
thesystem keys set xai xai-...          # Added: Grok/xAI

# Boot the VM and all services (proxy auto-starts)
thesystem start
```

## What You Get

A complete multi-agent development environment running in an isolated Lima VM:

- **agentchat server** — WebSocket relay for agent communication
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

Your agentchat server runs locally. Other instances can connect to you. Dashboard is available at localhost. This is the decentralized path — every instance is a node.

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
thesystem go                      Open interactive shell inside the VM
thesystem keys set <provider> <key>   Store API key in macOS Keychain
thesystem keys get <provider>         Read API key from macOS Keychain
thesystem agentauth start         Start the host-side agentauth proxy manually
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
thesystem keys set xai key-...       # xAI (Grok) API key
thesystem keys set google AIza...    # Google Generative AI API key
```

The agentauth proxy starts automatically as part of `thesystem start`. You can also run it manually with `thesystem agentauth start` if needed outside of the normal start sequence.

### Supported Providers

| Provider | Setup Command | Environment Variable | Upstream |
|----------|---------------|----------------------|----------|
| Anthropic Claude | `thesystem keys set anthropic sk-ant-...` | `ANTHROPIC_BASE_URL` → `/anthropic/*` | https://api.anthropic.com |
| OpenAI GPT | `thesystem keys set openai sk-...` | `OPENAI_BASE_URL` → `/openai/*` | https://api.openai.com |
| xAI Grok | `thesystem keys set xai key-...` | `XAI_BASE_URL` → `/xai/*` | https://api.x.ai |
| Google Gemini | `thesystem keys set google AIza...` | `GOOGLE_API_KEY` → `/google/*` | https://generativelanguage.googleapis.com |

### Setting Up Each Provider

#### Anthropic Claude

1. Get your API key from https://console.anthropic.com/account/keys
2. Store it:
   ```bash
   thesystem keys set anthropic sk-ant-...
   ```
3. Inside the VM, use:
   ```bash
   export ANTHROPIC_BASE_URL='http://host.lima.internal:9999/anthropic'
   export ANTHROPIC_API_KEY='proxy-managed'
   ```

#### OpenAI GPT

1. Get your API key from https://platform.openai.com/account/api-keys
2. Store it:
   ```bash
   thesystem keys set openai sk-...
   ```
3. Inside the VM, use:
   ```bash
   export OPENAI_BASE_URL='http://host.lima.internal:9999/openai'
   export OPENAI_API_KEY='proxy-managed'
   ```

#### xAI Grok

1. Get your API key from https://console.x.ai
2. Store it:
   ```bash
   thesystem keys set xai key-...
   ```
3. Inside the VM, use:
   ```bash
   export XAI_BASE_URL='http://host.lima.internal:9999/xai'
   export XAI_API_KEY='proxy-managed'
   ```
4. Or use the Grok client directly (compatible with OpenAI SDK):
   ```python
   from openai import OpenAI
   client = OpenAI(base_url="http://host.lima.internal:9999/xai", api_key="proxy-managed")
   ```

#### Google Generative AI (Gemini)

1. Get your API key from https://ai.google.dev/tutorials/setup
   - Create a project in Google Cloud Console
   - Enable the Generative AI API
   - Create an API key
2. Store it:
   ```bash
   thesystem keys set google AIza...
   ```
3. Inside the VM, use with the Google SDK:
   ```python
   import google.generativeai as genai
   genai.configure(api_key="AIza...")  # or read from env
   ```
4. For REST API calls, use the proxy:
   ```bash
   curl -X GET "http://host.lima.internal:9999/google/v1beta/models" \
     -H "x-goog-api-key: proxy-managed"
   ```

### Complete Multi-Provider Setup Example

```bash
# Store all keys (one-time)
thesystem keys set anthropic sk-ant-...
thesystem keys set openai sk-...
thesystem keys set xai key-...
thesystem keys set google AIza...

# Boot the system
thesystem start

# Inside the VM or agent container, all providers are auto-configured
thesystem go
```

## Architecture

The proxy acts as an API key router. Keys never enter the VM.

```
┌──── Your Mac ──────────────────────────────────────────────┐
│                                                             │
│  thesystem CLI (host-side, manages VM lifecycle)            │
 │  agentauth proxy :9999 (API key router, reads Keychain)    │
 │    ├─ /anthropic/* → api.anthropic.com (w/ x-api-key)     │
 │    ├─ /openai/* → api.openai.com (w/ Bearer token)        │
 │    ├─ /xai/* → api.x.ai (w/ Bearer token)                 │
 │    └─ /google/* → generativelanguage.googleapis.com (key)  │
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
- The agentauth proxy binds to `0.0.0.0` so Lima containers can reach it via `host.lima.internal`. Restrict external access via macOS firewall.
- The agentauth proxy auto-starts with `thesystem start` — no manual step required.
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
- **Swarm won't start**: The proxy should auto-start, but check health with `curl http://localhost:9999/agentauth/health`. If it fails, ensure keys are set (`thesystem keys set anthropic <key>`) then retry.
- **VM won't start**: Check `limactl list`. Delete and recreate with `thesystem destroy && thesystem start`.
- **Port conflict**: Another process using 6667 or 3000. Change ports in `thesystem.yaml`.
- **Slow first start**: First run downloads Ubuntu image and installs packages. Subsequent starts are fast.
- **Components out of date**: Run `thesystem reinstall` to force a fresh install inside the VM.
- **`limactl shell thesystem` fails**: Lima resolves your cwd inside the VM, so running the command from a directory that isn't mounted will error. Use `cd /tmp && limactl shell thesystem` or add an alias: `alias entersystem='cd /tmp && limactl shell thesystem'`.


## Per-Provider Troubleshooting

### Anthropic
- **401 Unauthorized**: Verify key with `thesystem keys get anthropic`. Key should start with `sk-ant-`.
- **Empty key error**: Key not stored in Keychain. Run `thesystem keys set anthropic <key>` first.

### OpenAI
- **401 Unauthorized**: Verify with `thesystem keys get openai`. Key should start with `sk-`.
- **Rate limited**: Check OpenAI account quotas at https://platform.openai.com/account/billing/limits

### xAI (Grok)
- **401 Unauthorized**: Verify with `thesystem keys get xai`. Get new key from https://console.x.ai
- **Rate limited**: Grok has different tier limits. Check https://x.ai/docs/guides/usage-limits
- **SDK compatibility**: xAI API is OpenAI-compatible, so OpenAI libraries work with custom base URL

### Google Generative AI (Gemini)
- **Permission denied**: API key not activated for Generative AI. Enable it in Google Cloud Console.
- **404 on REST endpoint**: Verify you're using the correct endpoint format for your key type.
- **Rate limit (429)**: Google enforces per-project quotas. Use a dedicated key for agent workloads.
- **Get API key from**: https://ai.google.dev/tutorials/setup → "Create API key"

### Proxy Health Check

```bash
# Verify proxy is running and lists supported backends
curl http://localhost:9999/agentauth/health

# Expected response:
# {"status":"ok","backends":["anthropic","openai","xai","google","github"],"port":9999}
```
## License

MIT
