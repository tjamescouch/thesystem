# constraints

## packages

- all components are installed from npm (TypeScript/Node ecosystem)
- TheSystem itself is an npm package: `npm install -g thesystem`
- alternative install via brew: `brew install thesystem`
- components are peer dependencies — TheSystem manages their installation

## compatibility

- TheSystem maintains a compatibility matrix: `{ component: version-range }`
- installing or upgrading a component checks the matrix before proceeding
- incompatible upgrades are blocked with a clear error and suggested resolution
- the matrix is embedded in each TheSystem release, not fetched remotely

## configuration

- configuration lives in `thesystem.yaml` in the project root
- sensible defaults for everything — config file is optional for basic usage
- config schema is validated on load with clear error messages
- secrets (API keys, tokens) are stored in macOS Keychain via `thesystem keys set`, never in config or env vars; the agentauth proxy reads them at runtime

## network

- TheSystem binds to localhost by default — no external exposure without explicit config
- each component gets its own port from a default range
- port conflicts are detected and reported at startup

## process management

- TheSystem spawns components as child processes
- graceful shutdown: SIGTERM to all children, wait for drain, then exit
- health checks on each component — restart on failure with backoff (target state; not yet implemented)
- logs from all components are multiplexed to stdout with component prefixes (target state; not yet implemented)

## language

- TypeScript, compiled to JavaScript, runs on Node.js
- no native dependencies — pure JS for maximum portability
- minimum Node.js version: 20 LTS
