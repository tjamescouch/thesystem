# bootstrap

how TheSystem goes from `thesystem init` to a running dev shop.

## init flow

1. user runs `thesystem init`
2. config-loader generates default thesystem.yaml in cwd
3. compatibility-checker resolves latest compatible versions for all components
4. cli installs components via npm: agentchat, agentctl-swarm, agentdash
5. cli reports installed versions and ports
6. user edits thesystem.yaml if needed (optional)

## start flow

1. user runs `thesystem start`
2. config-loader reads and resolves thesystem.yaml
3. compatibility-checker validates all installed versions
4. if incompatible: error with resolution suggestions, abort
5. orchestrator boots components in order:
   a. agentchat server (communication layer — everything depends on this)
   b. agentctl-swarm (agent fleet — needs server to connect to)
   c. agentdash (web UI — needs server to monitor)
6. orchestrator waits for each component's health check before starting the next
7. cli prints status table: component, version, port, status
8. system is ready

## stop flow

1. user runs `thesystem stop` (or Ctrl+C)
2. orchestrator sends SIGTERM to components in reverse order:
   a. agentdash
   b. agentctl-swarm
   c. agentchat server
3. each component gets 5 seconds to drain before SIGKILL
4. orchestrator confirms all processes exited
5. cli prints "TheSystem stopped"
