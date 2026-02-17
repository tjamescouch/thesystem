# cli

the user-facing command-line interface.

## state

- parsed command and flags
- resolved config (defaults merged with thesystem.yaml)
- component registry (installed components and their versions)

## capabilities

### implemented ✅
- `thesystem init` — create thesystem.yaml with defaults, prompt for API keys → .env, validate prerequisites
- `thesystem start` — boot all components in dependency order (proxy → VM → services → swarm)
- `thesystem stop` — graceful shutdown of all components in reverse order
- `thesystem status` — show running components, versions, ports, health
- `thesystem destroy` — stop all services, delete Lima VM and all state
- `thesystem doctor` — check system health (node, lima, keys, proxy, VM, swarm)
- `thesystem config` — show resolved configuration as JSON
- `thesystem logs [service]` — tail recent logs for a service (agentchat-server, dashboard, swarm)
- `thesystem version` — print version
- `thesystem reinstall` — clean and reinstall all components inside the VM
- `thesystem keys set <provider> <key>` — store/update API key in macOS Keychain
- `thesystem keys get <provider>` — read API key from macOS Keychain (prints to stdout)
- `thesystem agentauth [start]` — start the host-side agentauth proxy (reads Keychain, required for swarm)

### not yet implemented ❌
- `thesystem keys rotate` — rotate key in Keychain and restart proxy
- `thesystem upgrade [component]` — upgrade a component within compatibility bounds

## interfaces

exposes:
- CLI binary `thesystem` with subcommands

depends on:
- config-loader (to read thesystem.yaml)
- orchestrator (to start/stop/manage components)
- compatibility-checker (to validate upgrades)

## invariants

- every command provides --help with usage examples
- destructive operations require confirmation
- exit codes: 0 success, 1 error, 2 misconfiguration
