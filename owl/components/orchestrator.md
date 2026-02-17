# orchestrator

manages the lifecycle of the Lima VM, services, and agent swarm.

## state

- VM status: created / running / stopped
- component status map: `{ name: { pid, port, status, restarts } }`
- system config (from config-loader)

## capabilities

### implemented ✅
- create/start/stop/destroy Lima VM via `limactl`
- generate Lima YAML from config (VM resources, port forwards, env vars)
- install packages on first run (agentchat, agentctl, claude-code, gro, niki, dashboard)
- `reinstall()` — clean and reinstall all components inside VM
- start services in dependency order: agentchat-server → dashboard → swarm
- stop services in reverse order via `pkill`
- wait for port readiness before starting downstream services
- daemonize processes via `setsid` for SSH-safe background execution
- forward env vars into VM (whitelist pattern: `ANTHROPIC_|THESYSTEM_|AGENTCHAT_|CLAUDE_CODE_`)
- strip secrets from env forwarding (5 key names blocked)
- inject agentauth proxy URLs into VM environment
- guard swarm startup on agentauth proxy health check
- expose component status via pgrep process detection

### not yet implemented ❌
- restart failed components with exponential backoff
- HTTP health endpoint probing (currently pgrep only)
- multiplex component logs to stdout with `[component]` prefixes
- restart single component
- egress filtering (iptables) on containers

## interfaces

exposes:
- `start(config)` — create/start VM, install packages, start services + swarm
- `stop()` — stop services in reverse order, stop VM
- `destroy()` — stop everything, delete VM
- `getStatus()` — return component health map

internal:
- `shell(command, timeout)` — execute command inside VM via limactl
- `daemonize(command, logFile)` — background-start a process in VM
- `waitForPort(port, timeout)` — poll until port is listening
- `generateLimaYaml(config)` — build VM template from config

depends on:
- config-loader (for system configuration)
- `limactl` binary (Lima VM management)
- agentauth proxy on host (for API key access)
- agentchat, agentctl, claude-code npm packages (installed inside VM)

## invariants

- secrets never enter the VM — enforced by SECRET_ENV_VARS set
- services are always stopped in reverse boot order
- VM creation uses temporary YAML file, cleaned up after create
- swarm never starts without healthy agentauth proxy
- all child processes are cleaned up on TheSystem exit (SIGTERM propagation)
