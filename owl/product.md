# TheSystem

install it and you have a team.

## what it is

a trust boundary orchestrator that bootstraps a complete multi-agent development environment from published packages. one command gives you: isolated agents, a communication server, a real-time dashboard, secure API access, and the tools to coordinate them all.

thesystem is the answer to: "I want N agents working on X, and I don't want to worry about key leaks, rogue processes, or credential theft."

## what it is not

- not a monorepo — each component lives in its own published package
- not a runtime — gro and claude-code are runtimes; thesystem orchestrates them
- not a messaging layer — agentchat is the messaging layer
- not a framework — it doesn't impose structure on your project

## first principles

### axiom 1: trust boundaries are sacred

three tiers, three trust levels:

| tier | trust | contains | destroyed by |
|------|-------|----------|-------------|
| host (macOS) | CRITICAL | API keys in Keychain, agentauth proxy, user | nothing — this is you |
| VM (Lima) | EXPENDABLE | services (agentchat, dashboard), shared state | `thesystem destroy` |
| containers (Podman) | SANDBOXED | one agent per container, no secrets, no egress | container kill |

keys never leave the host tier. agents never touch the host tier. the VM is a firebreak — if anything goes wrong, destroy and rebuild in minutes.

### axiom 2: composition over integration

thesystem doesn't contain the components — it installs, configures, and orchestrates them. each component is a standalone package that works independently. thesystem is the glue.

components:
- **agentchat** — messaging server + protocol
- **agentforce** — real-time dashboard UI
- **gro** — vendor-neutral LLM runtime (OpenAI, Anthropic, local)
- **claude-code** — Anthropic's agent runtime
- **agentctl** — CLI for agent fleet management
- **agentauth** — API key proxy + identity management
- **lucidity** — agent memory curation

### axiom 3: one command to start

`thesystem start` boots the entire stack. `thesystem stop` shuts it down. the human should never need to manage individual services manually unless they want to.

### axiom 4: progressive disclosure

a new user runs `thesystem init` and gets a working setup with sensible defaults. an advanced user edits `thesystem.yaml` to customize every detail. the simple path and the power-user path coexist.

### axiom 5: keys belong in Keychain

API keys are stored in macOS Keychain. not in .env files, not in environment variables, not in config files. the agentauth proxy reads from Keychain at startup and serves authenticated requests to agents via HTTP proxy. agents receive `ANTHROPIC_BASE_URL=http://proxy:9999/anthropic` and never see a real key.

## architecture

```
┌─────────────────────────────────────────────┐
│  HOST (macOS) — CRITICAL trust tier         │
│                                             │
│  ┌──────────┐  ┌────────────────────────┐   │
│  │ Keychain │──│ agentauth proxy :9999  │   │
│  │ (keys)   │  │ (reads keys, serves    │   │
│  └──────────┘  │  authenticated API)    │   │
│                └────────────┬───────────┘   │
│                             │ http           │
│  ┌──────────────────────────┴──────────────┐│
│  │  LIMA VM — EXPENDABLE trust tier        ││
│  │                                         ││
│  │  ┌─────────────┐  ┌──────────────────┐  ││
│  │  │ agentchat   │  │ agentforce       │  ││
│  │  │ server :6667│  │ dashboard :3000  │  ││
│  │  └──────┬──────┘  └──────────────────┘  ││
│  │         │                                ││
│  │  ┌──────┴───────────────────────────┐   ││
│  │  │  PODMAN CONTAINERS — SANDBOXED   │   ││
│  │  │                                  │   ││
│  │  │  ┌────────┐ ┌────────┐ ┌──────┐ │   ││
│  │  │  │agent-1 │ │agent-2 │ │agent │ │   ││
│  │  │  │(claude)│ │(gro)   │ │ ...N │ │   ││
│  │  │  └────────┘ └────────┘ └──────┘ │   ││
│  │  │  network: agentchat + proxy only │   ││
│  │  └──────────────────────────────────┘   ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

## lifecycle

### init
```
thesystem init
```
1. create `thesystem.yaml` with sensible defaults
2. prompt for API keys → store in macOS Keychain
3. validate prerequisites (lima, podman, node ≥ 20)

### start
```
thesystem start
```
1. start agentauth proxy on host (reads Keychain)
2. create or start Lima VM (Ubuntu 24.04)
3. install packages on first run (agentchat, agentctl, claude-code)
4. start services in dependency order:
   - agentchat-server → wait for port
   - agentforce dashboard → wait for port
5. start agent swarm (N Podman containers)
   - guard: require agentauth proxy healthy
   - each container gets: proxy URL, agentchat URL, mission config
   - no secrets enter the VM or containers

### stop
```
thesystem stop
```
1. stop swarm (SIGTERM → 5s → SIGKILL)
2. stop dashboard
3. stop agentchat-server
4. stop Lima VM

### destroy
```
thesystem destroy
```
1. stop all services
2. delete Lima VM and all state
3. "run `thesystem start` to rebuild"

## configuration

```yaml
# thesystem.yaml
mode: server              # 'server' = run agentchat locally, 'client' = connect to remote

server:
  port: 6667
  dashboard: 3000
  allowlist: true

client:
  remote: wss://agentchat-server.fly.dev

swarm:
  agents: 2
  backend: claude          # 'claude' or 'gro'

vm:
  cpus: 4
  memory: 8GiB
  disk: 40GiB
  mount: ~/dev             # read-only in VM

channels:
  - '#general'
  - '#agents'
```

env var substitution: `${VAR}` in any string value resolves to `process.env.VAR`.

## security model

### secret isolation
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_TOKEN_BEARER` — **never forwarded into VM**
- agents access LLM APIs via `http://host.lima.internal:9999/anthropic`
- agentauth proxy on host is the only process that touches real keys

### env forwarding whitelist
only vars matching these patterns enter the VM:
- `ANTHROPIC_*` (minus the API key)
- `THESYSTEM_*`
- `AGENTCHAT_*`
- `CLAUDE_CODE_*`

### container network isolation (target state)
each Podman container can only reach:
- `localhost:6667` — agentchat server
- `host.lima.internal:9999` — agentauth proxy
- no other egress (iptables enforcement)

### key management (target state — Mac turnkey)
- `thesystem init` prompts for keys → macOS Keychain
- `thesystem start` starts agentauth proxy → reads from Keychain
- `thesystem keys set <provider> <key>` — update Keychain entry
- `thesystem keys rotate` — generate new key, update Keychain, restart proxy
- keys never exist as env vars, .env files, or config values

## status codes

```
thesystem status
```
returns component health map:

| component | check method | healthy | degraded |
|-----------|-------------|---------|----------|
| vm | `limactl list --json` | Running | Stopped |
| agentchat-server | port probe :6667 | listening | not listening |
| agentforce-dashboard | port probe :3000 | listening | not listening |
| agentctl-swarm | pgrep | processes found | no processes |
| agentauth-proxy | curl /agentauth/health | 200 OK | unreachable |

## diagnostics

```
thesystem doctor
```
checks:
- Node.js ≥ 20 installed
- Lima installed and responsive
- Podman available in VM
- API keys present in Keychain
- agentauth proxy reachable
- ports not in use by other processes
- VM provisioning complete (.provisioned flag)

## compatibility matrix

embedded in each release:
```
@tjamescouch/agentchat: ≥0.22.0 <1.0.0
agentctl-swarm: ≥0.1.0 <1.0.0
agentforce: ≥0.1.0 <1.0.0
```

checked on startup and upgrade. incompatible versions block with suggested resolution.

## gap status

### implemented ✅
- Lima VM creation, start, stop, destroy
- YAML config loading with env var substitution
- Service startup in dependency order (server → dashboard → swarm)
- Secret stripping (5 keys blocked from VM)
- Agentauth proxy health gate before swarm start
- Compatibility matrix validation
- CLI: init, start, stop, status, destroy, doctor, logs, config, version, reinstall
- **macOS Keychain integration** — `thesystem keys set/get`; agentauth proxy reads from Keychain
- **agentauth proxy** — host-side HTTP proxy; agents route LLM calls through it; keys never enter VM
- **Per-agent Podman containers** — managed by agentctl-swarm
- **gro runtime** — installed alongside claude-code on first run

### not yet implemented ❌
- **Service restart with backoff** — dead services stay dead
- **HTTP health probing** — only pgrep, no HTTP checks
- **Log multiplexing** — logs go to separate files (`/tmp/*.log`), not stdout with prefixes
- **Egress filtering (iptables)** — discussed, not enforced
- **Restart single component** — `restart(component)` interface missing
- **`thesystem keys rotate`** — rotate key in Keychain and restart proxy

## components

see [components/](components/)

## behaviors

see [behaviors/](behaviors/)

## constraints

see [constraints.md](constraints.md)
