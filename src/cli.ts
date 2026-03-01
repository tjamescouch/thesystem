#!/usr/bin/env node

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, writeDefaultConfig } from './config-loader';
import { Orchestrator } from './orchestrator';
import { ComponentStatus } from './types';
import { runInit } from './init';

const exec = promisify(execFile);
const VERSION = '0.2.0';

function printUsage(): void {
  console.log(`
thesystem v${VERSION} — install it and you have a dev shop

Usage:
  thesystem init              Create thesystem.yaml with defaults
  thesystem start             Boot Lima VM and all services
  thesystem stop              Graceful shutdown (services + VM)
  thesystem status            Show component status
  thesystem destroy           Delete VM (rebuild from scratch on next start)
  thesystem doctor            Check prerequisites and health
  thesystem config            Show resolved configuration
  thesystem logs [svc]        Tail logs from a service (server, dashboard, swarm)
  thesystem secrets set <k> <v> Store a secret in OS keychain
  thesystem secrets get <k>     Retrieve a secret (masked)
  thesystem secrets delete <k>  Remove a secret
  thesystem secrets list        Show known secret key names
  thesystem daemon install      Install launchd agent (auto-start on login)
  thesystem daemon uninstall    Remove launchd agent
  thesystem daemon status       Show daemon status
  thesystem version             Show version
  thesystem reinstall           Reinstall components inside VM
  thesystem gro [args...]       Run gro in a pod (resumes last session by default)
  thesystem gro --no-continue   Start a fresh gro session (no resume)
  thesystem gro --rebuild       Force rebuild the gro container image
  thesystem gro --dev           Mount host gro source for rapid iteration (no publish needed)
  thesystem gtui [args...]      Run gtui (TUI for gro) in a pod
  thesystem gtui --rebuild      Force rebuild the gtui container image
  thesystem gtui --dev          Mount host gro+gtui source for rapid iteration
  thesystem go                  Open an interactive shell inside the VM
  thesystem agentctl <cmd>      Run agentctl commands inside the VM
  thesystem keys set            Store API keys in macOS Keychain
  thesystem keys get            Read API keys from macOS Keychain (prints to stdout)
  thesystem agentauth           Run local agentauth proxy (required for swarm)
  thesystem help                Show this message

Options:
  thesystem init -y       Non-interactive init (skip prompts)
`);
}

function printStatusTable(statuses: ComponentStatus[]): void {
  const header = 'Component'.padEnd(25) + 'Port'.padEnd(8) + 'PID'.padEnd(10) + 'Status';
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const s of statuses) {
    console.log(
      s.name.padEnd(25) +
      (s.port != null ? String(s.port) : '-').padEnd(8) +
      (s.pid != null ? String(s.pid) : '-').padEnd(10) +
      s.status
    );
  }
}

async function checkCommand(name: string): Promise<boolean> {
  try {
    await exec('which', [name]);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command) {
    case 'init': {
      const nonInteractive = args.includes('--yes') || args.includes('-y');
      await runInit({ cwd: process.cwd(), nonInteractive });
      break;
    }

    case 'start': {
      const config = loadConfig();
      console.log(`[thesystem] Mode: ${config.mode}`);

      const orchestrator = new Orchestrator();

      const gracefulShutdown = async (signal: string) => {
        console.log(`\n[thesystem] Caught ${signal}, shutting down...`);
        const forceTimeout = setTimeout(() => {
          console.error('[thesystem] Shutdown timed out after 30s, forcing exit.');
          process.exit(1);
        }, 30000);
        try {
          await orchestrator.stop();
        } catch (err: any) {
          console.error(`[thesystem] Error during shutdown: ${err.message}`);
        }
        clearTimeout(forceTimeout);
        process.exit(0);
      };

      process.on('SIGINT', () => gracefulShutdown('SIGINT'));
      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

      await orchestrator.start(config);

      console.log('\n[thesystem] Status:');
      const statuses = await orchestrator.getStatus();
      printStatusTable(statuses);

      if (config.mode === 'server') {
        console.log(`\n[thesystem] Dashboard: http://localhost:${config.server.dashboard}`);
        console.log(`[thesystem] AgentChat: ws://localhost:${config.server.port}`);
      } else {
        console.log(`\n[thesystem] Connected to: ${config.client.remote}`);
      }

      console.log('[thesystem] Running. Press Ctrl+C to stop.');
      await new Promise(() => {});
      break;
    }

    case 'stop': {
      const orchestrator = new Orchestrator();
      await orchestrator.stop();
      break;
    }

    case 'status': {
      const config = loadConfig();
      const orchestrator = new Orchestrator();
      orchestrator.setConfig(config);
      const statuses = await orchestrator.getStatus();
      printStatusTable(statuses);
      break;
    }

    case 'destroy': {
      const orchestrator = new Orchestrator();
      await orchestrator.destroy();
      break;
    }

    case 'doctor': {
      console.log('[thesystem] Running diagnostics...\n');

      // Node
      const nodeVersion = process.versions.node;
      const [major] = nodeVersion.split('.').map(Number);
      console.log(`  Node.js ${nodeVersion} ... ${major >= 20 ? 'ok' : 'FAIL (need >= 20)'}`);

      // Lima
      const hasLima = await checkCommand('limactl');
      console.log(`  limactl ... ${hasLima ? 'ok' : 'MISSING (brew install lima)'}`);

      // Config
      try {
        const config = loadConfig();
        console.log(`  thesystem.yaml ... ok (mode: ${config.mode})`);
      } catch {
        console.log('  thesystem.yaml ... not found (will use defaults)');
      }

      // API key / auth token: prefer Keychain via agentauth proxy.
      // SECURITY: fail fast if secrets are present in env (exfil risk).
      const envSecrets = [
        'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY',
        'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY',
        'DEEPSEEK_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_TOKEN_BEARER',
      ].filter(k => !!process.env[k]);
      if (envSecrets.length) {
        console.log(`  API auth ... WARN (secrets present in env: ${envSecrets.join(', ')})`);
        console.log('           Use: thesystem keys set <provider> <key>  (stores in macOS Keychain)');
        console.log('           Then: unset the env vars for maximum security');
      } else {
        console.log('  API auth ... ok (no secrets in env)');
        console.log('           Note: swarm requires agentauth proxy healthy on localhost:9999');
      }

      // VM state
      if (hasLima) {
        const orchestrator = new Orchestrator();
        const running = await orchestrator.isVmRunning();
        const created = await orchestrator.isVmCreated();
        if (running) {
          console.log('  VM ... running');

          // Check services inside VM
          try {
            const { stdout } = await exec('limactl', ['shell', 'thesystem', 'bash', '-c',
              'echo "node $(node --version 2>/dev/null || echo missing)"'
            ]);
            console.log(`  VM ${stdout.trim()}`);
          } catch {
            console.log('  VM services ... unable to query');
          }

          // Check swarm process
          try {
            const { stdout: swarmPid } = await exec('limactl', ['shell', 'thesystem', 'bash', '-c',
              'pgrep -f "agentctl start" | head -1'
            ]);
            console.log(`  Swarm ... ${swarmPid.trim() ? `running (PID ${swarmPid.trim()})` : 'not running'}`);
          } catch {
            console.log('  Swarm ... not running');
          }
        } else if (created) {
          console.log('  VM ... stopped (run: thesystem start)');
        } else {
          console.log('  VM ... not created (run: thesystem start)');
        }
      }

      console.log('\n[thesystem] Diagnostics complete.');
      break;
    }

    case 'keys': {
      const sub = args[1] || 'help';
      if (sub === 'set') {
        const provider = args[2];
        const key = args[3];
        if (!provider || !key) {
          console.error('Usage: thesystem keys set <provider> <key>');
          process.exit(1);
        }
        const svc = `thesystem/${provider}`;
        // macOS Keychain (generic password): account=provider, service=thesystem/<provider>
        // -U updates existing
        await exec('security', ['add-generic-password', '-a', provider, '-s', svc, '-w', key, '-U']);
        console.log(`[thesystem] Stored key in macOS Keychain service="${svc}" account="${provider}"`);
        break;
      }
      if (sub === 'get') {
        const provider = args[2];
        if (!provider) {
          console.error('Usage: thesystem keys get <provider>');
          process.exit(1);
        }
        const svc = `thesystem/${provider}`;
        const { stdout } = await exec('security', ['find-generic-password', '-a', provider, '-s', svc, '-w']);
        process.stdout.write(stdout);
        break;
      }
      console.error('Usage: thesystem keys <set|get> ...');
      process.exit(1);
    }

    case 'agentauth': {
      const sub = args[1] || 'start';
      if (sub !== 'start') {
        console.error('Usage: thesystem agentauth start');
        process.exit(1);
      }
      // Lazy import so CLI still works in minimal envs.
      const { startAgentAuthProxy } = await import('./keychain-agentauth');
      const port = Number(process.env.AGENTAUTH_PORT || 9999);
      const bind = process.env.AGENTAUTH_BIND || '0.0.0.0';
      await startAgentAuthProxy({ port, bind });
      break;
    }

    case 'logs': {
      const svc = args[1] || 'server';
      const logMap: Record<string, string> = {
        server: '/tmp/agentchat-server.log',
        dashboard: '/tmp/agentdash.log',
        swarm: '/tmp/agentctl-swarm.log',
      };
      // Support per-provider swarm logs: "thesystem logs swarm-groq"
      if (svc.startsWith('swarm-')) {
        logMap[svc] = `/tmp/agentctl-${svc}.log`;
      }
      const logFile = logMap[svc];
      if (!logFile) {
        console.error(`Unknown service "${svc}". Options: server, dashboard, swarm, swarm-<provider>`);
        process.exit(1);
      }

      try {
        const { stdout } = await exec('limactl', ['shell', 'thesystem', 'tail', '-50', logFile]);
        console.log(stdout);
      } catch (err: any) {
        console.error(`Failed to read logs: ${err.message}`);
      }
      break;
    }

    case 'daemon': {
      const subcommand = args[1] || 'status';
      const PLIST_LABEL = 'com.thesystem.daemon';
      const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
      const DAEMON_LOG = path.join(os.homedir(), '.thesystem', 'daemon.log');
      const DAEMON_ERR = path.join(os.homedir(), '.thesystem', 'daemon.err');

      if (subcommand === 'install') {
        const config = loadConfig();
        const serverUrl = config.mode === 'server'
          ? `ws://localhost:${config.server.port}`
          : config.client.remote;

        // Find agentchat binary
        let agentchatBin: string;
        try {
          const { stdout } = await exec('which', ['agentchat']);
          agentchatBin = stdout.trim();
        } catch {
          // Check common locations
          const npmGlobal = path.join(os.homedir(), '.npm-global', 'bin', 'agentchat');
          if (fs.existsSync(npmGlobal)) {
            agentchatBin = npmGlobal;
          } else {
            console.error('[thesystem] agentchat not found. Install it first: npm install -g @tjamescouch/agentchat');
            process.exit(1);
            return;
          }
        }

        // Find identity file (God identity or default)
        const identityDir = path.join(os.homedir(), '.agentchat', 'identities');
        const godIdentity = path.join(identityDir, 'God.json');
        const defaultIdentity = path.join(identityDir, 'claude-opus.json');
        const identityPath = fs.existsSync(godIdentity) ? godIdentity
          : fs.existsSync(defaultIdentity) ? defaultIdentity
          : '';

        const identityArgs = identityPath ? `        <string>--identity</string>\n        <string>${identityPath}</string>` : '';

        const channels = config.channels.map(
          (ch: string) => `        <string>${ch}</string>`
        ).join('\n');

        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${agentchatBin}</string>
        <string>daemon</string>
        <string>${serverUrl}</string>
${identityArgs}
        <string>--channels</string>
${channels}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${DAEMON_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${DAEMON_ERR}</string>
    <key>WorkingDirectory</key>
    <string>${os.homedir()}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${path.dirname(agentchatBin)}</string>
    </dict>
</dict>
</plist>`;

        // Ensure dirs exist
        fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
        fs.mkdirSync(path.dirname(DAEMON_LOG), { recursive: true });

        fs.writeFileSync(PLIST_PATH, plist);
        console.log(`[thesystem] Wrote ${PLIST_PATH}`);

        // Load the agent
        try {
          await exec('launchctl', ['unload', PLIST_PATH]).catch(() => {});
          await exec('launchctl', ['load', PLIST_PATH]);
          console.log(`[thesystem] Daemon installed and started.`);
          console.log(`[thesystem] Server: ${serverUrl}`);
          if (identityPath) console.log(`[thesystem] Identity: ${path.basename(identityPath)}`);
          console.log(`[thesystem] Log: ${DAEMON_LOG}`);
          console.log(`[thesystem] Starts automatically on login.`);
        } catch (err: any) {
          console.error(`[thesystem] Failed to load agent: ${err.message}`);
          console.log(`[thesystem] Plist written. Load manually: launchctl load ${PLIST_PATH}`);
        }

      } else if (subcommand === 'uninstall') {
        if (fs.existsSync(PLIST_PATH)) {
          try {
            await exec('launchctl', ['unload', PLIST_PATH]);
          } catch { /* may not be loaded */ }
          fs.unlinkSync(PLIST_PATH);
          console.log('[thesystem] Daemon uninstalled.');
        } else {
          console.log('[thesystem] Daemon not installed.');
        }

      } else if (subcommand === 'status') {
        if (!fs.existsSync(PLIST_PATH)) {
          console.log('[thesystem] Daemon not installed. Run: thesystem daemon install');
          break;
        }

        try {
          const { stdout } = await exec('launchctl', ['list', PLIST_LABEL]);
          console.log(`[thesystem] Daemon installed: ${PLIST_PATH}`);
          // Parse launchctl output for PID
          const pidMatch = stdout.match(/"PID"\s*=\s*(\d+)/);
          if (pidMatch) {
            console.log(`[thesystem] PID: ${pidMatch[1]}`);
          }
          const statusMatch = stdout.match(/"LastExitStatus"\s*=\s*(\d+)/);
          if (statusMatch) {
            console.log(`[thesystem] Last exit: ${statusMatch[1]}`);
          }
          console.log(`[thesystem] Log: ${DAEMON_LOG}`);
        } catch {
          console.log('[thesystem] Daemon installed but not loaded.');
          console.log(`[thesystem] Load with: launchctl load ${PLIST_PATH}`);
        }

      } else {
        console.error(`Unknown daemon subcommand "${subcommand}". Options: install, uninstall, status`);
        process.exit(1);
      }
      break;
    }

    case 'secrets': {
      const { createSecretStore } = await import('./secret-store');
      const secrets = await createSecretStore();
      const sub = args[1] || 'help';

      if (sub === 'set' && args[2] && args[3]) {
        await secrets.set(args[2], args[3]);
        console.log(`[thesystem] Secret '${args[2]}' stored.`);
      } else if (sub === 'get' && args[2]) {
        const value = await secrets.get(args[2]);
        if (value) {
          // Show only first/last 4 chars for safety
          const masked = value.length > 12
            ? `${value.slice(0, 4)}...${value.slice(-4)}`
            : '****';
          console.log(`[thesystem] ${args[2]}: ${masked} (${value.length} chars)`);
        } else {
          console.log(`[thesystem] Secret '${args[2]}' not found.`);
        }
      } else if (sub === 'delete' && args[2]) {
        await secrets.delete(args[2]);
        console.log(`[thesystem] Secret '${args[2]}' deleted.`);
      } else if (sub === 'list') {
        console.log('[thesystem] Known secret keys:');
        console.log('  oauth-token       Claude Code OAuth token');
        console.log('  anthropic-api-key  Anthropic API key');
        console.log('  gh-token          GitHub personal access token');
        console.log('  moltx-api-key     MoltX social media API key');
        console.log('  moltbook-api-key  Moltbook API key');
        console.log('\nUse: thesystem secrets get <key-name>');
      } else {
        console.log(`
thesystem secrets — manage credentials securely

Usage:
  thesystem secrets set <key> <value>   Store a secret
  thesystem secrets get <key>           Retrieve a secret (masked output)
  thesystem secrets delete <key>        Remove a secret
  thesystem secrets list                Show known secret key names
`);
      }
      break;
    }

    case 'config': {
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
      break;
    }

    case 'version': {
      console.log(`thesystem v${VERSION}`);
      break;
    }

    case 'reinstall': {
      console.log('[thesystem] Reinstalling components inside VM...');
      const orchestrator = new Orchestrator();
      const running = await orchestrator.isVmRunning();
      if (!running) {
        console.error('[thesystem] VM is not running. Start it first: thesystem start');
        process.exit(1);
      }
      await (orchestrator as any).reinstall();
      break;
    }

    case 'gro': {
      // Run gro interactive mode in a podman container inside the VM.
      // Flow: macOS → limactl shell → podman run -it → gro -c (continue session)
      // Usage: thesystem gro [gro-args...]
      //   e.g. thesystem gro -P openai
      //        thesystem gro -P groq -m llama-3.3-70b-versatile
      //        thesystem gro --no-continue   (fresh session instead of resuming)
      //        thesystem gro --rebuild       (force rebuild container image)
      const vmName = 'thesystem';
      const rebuild = args.includes('--rebuild');
      const noContinue = args.includes('--no-continue');
      const devMode = args.includes('--dev');
      const plasticMode = args.includes('--plastic');
      const groArgs = args.slice(1).filter(a => a !== '--' && a !== '--rebuild' && a !== '--no-continue' && a !== '--dev' && a !== '--plastic');

      const orchestrator = new Orchestrator();
      const running = await orchestrator.isVmRunning();
      if (!running) {
        console.error('[thesystem] VM is not running. Start it first: thesystem start');
        process.exit(1);
      }

      // Check agentauth proxy is healthy
      const proxyPort = process.env.AGENTAUTH_PORT || '9999';
      try {
        await exec('/usr/bin/curl', ['-sf', `http://localhost:${proxyPort}/agentauth/health`], { timeout: 2000 });
      } catch {
        console.error(`[thesystem] agentauth proxy not running on :${proxyPort}. Run: thesystem agentauth start`);
        process.exit(1);
      }

      // Ensure wormhole relay is running (non-blocking — pods can work without it)
      const wormholePort = process.env.WORMHOLE_PORT || '8787';
      try {
        const { stdout: httpCode } = await exec('/usr/bin/curl', ['-so', '/dev/null', '-w', '%{http_code}', `http://localhost:${wormholePort}/`], { timeout: 2000 });
        if (httpCode.trim() !== '000') console.log(`[thesystem] wormhole relay on :${wormholePort}`);
        else throw new Error('not running');
      } catch {
        try {
          await exec('which', ['wormhole'], { timeout: 2000 });
          console.log('[thesystem] Starting wormhole relay...');
          const wormholeChild = spawn('wormhole', ['relay', '-r', wormholePort], {
            detached: true, stdio: 'ignore', env: { ...process.env },
          });
          wormholeChild.unref();
          await new Promise(r => setTimeout(r, 1500));
          console.log(`[thesystem] wormhole relay started on :${wormholePort}`);
        } catch {
          console.log('[thesystem] wormhole not installed — skipping relay (npm i -g @tjamescouch/wormhole)');
        }
      }

      // Build container image inside VM if not present (or --rebuild)
      const imageCheck = rebuild ? 'false' : 'podman image exists thesystem-gro:latest 2>/dev/null';
      const buildScript = [
        'export PATH="$HOME/.npm-global/bin:$PATH"',
        `if ! ${imageCheck}; then`,
        `  echo '[thesystem] Building gro container image...'`,
        `  podman build --no-cache -t thesystem-gro:latest -f- /tmp <<'CONTAINERFILE_EOF'`,
        'FROM node:20-slim',
        'RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*',
        'RUN npm install -g @tjamescouch/gro agentpatch @tjamescouch/wormhole && npm cache clean --force',
        'USER node',
        'WORKDIR /home/node',
        'ENTRYPOINT ["gro"]',
        'CMD ["-i"]',
        'CONTAINERFILE_EOF',
        `  echo '[thesystem] Image built.'`,
        'else',
        `  echo '[thesystem] Image ready.'`,
        'fi',
      ].join('\n');

      const buildChild = spawn('limactl', ['shell', '--workdir', '/home', vmName, 'bash', '-c', buildScript], {
        stdio: 'inherit',
      });
      await new Promise<void>((resolve, reject) => {
        buildChild.on('close', (code) => {
          if (code !== 0) reject(new Error(`Image build failed with code ${code}`));
          else resolve();
        });
        buildChild.on('error', reject);
      });

      // Build env flags for all provider proxies
      const proxyBase = `http://host.lima.internal:${proxyPort}`;
      const envPairs: [string, string][] = [
        ['ANTHROPIC_BASE_URL', `${proxyBase}/anthropic`],
        ['ANTHROPIC_API_KEY', 'proxy-managed'],
        ['OPENAI_BASE_URL', `${proxyBase}/openai`],
        ['OPENAI_API_KEY', 'proxy-managed'],
        ['XAI_BASE_URL', `${proxyBase}/xai`],
        ['XAI_API_KEY', 'proxy-managed'],
        ['GROQ_BASE_URL', `${proxyBase}/groq`],
        ['GROQ_API_KEY', 'proxy-managed'],
        ['GOOGLE_BASE_URL', `${proxyBase}/google`],
        ['GOOGLE_API_KEY', 'proxy-managed'],
        ['DEEPSEEK_BASE_URL', `${proxyBase}/deepseek`],
        ['DEEPSEEK_API_KEY', 'proxy-managed'],
        ['MISTRAL_BASE_URL', `${proxyBase}/mistral`],
        ['MISTRAL_API_KEY', 'proxy-managed'],
        ['WORMHOLE_RELAY', `http://host.lima.internal:${wormholePort}`],
      ];
      if (plasticMode) {
        envPairs.push(['GRO_PLASTIC', '1']);
      }
      const envFlags = envPairs.map(([k, v]) => `-e ${k}=${v}`).join(' ');

      // Named podman volume for persistent gro sessions.
      // Podman manages ownership for rootless containers automatically.
      const volSetup = `podman volume exists thesystem-gro 2>/dev/null || podman volume create thesystem-gro`;
      const volMount = `-v thesystem-gro:/home/node/.gro`;

      // --dev: bind-mount host gro source over the container's global install.
      // Lima mounts /Users/jamescouch/dev → /home/jamescouch.linux/dev (read-only).
      // This overlays the host's latest tsc build so changes are picked up instantly
      // without npm publish or container rebuild.
      const devMount = devMode
        ? `-v /home/jamescouch.linux/dev/gro:/usr/local/lib/node_modules/@tjamescouch/gro:ro`
        : '';
      if (devMode) console.log('[thesystem] Dev mode: mounting host gro source into container');

      // Default to -c (continue/resume session); --no-continue forces -i (fresh).
      // When using -c, fall back to -i if there's no session to resume.
      const escapedGroArgs = groArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const extraArgs = groArgs.length > 0 ? ` ${escapedGroArgs}` : '';
      // --autodiscover-mcp: let gro auto-load ~/.gro/mcp.json inside the container
      // PLASTIC mode uses gro-supervised as entrypoint — the supervisor holds warm
      // state in its heap across @@reboot@@ cycles via IPC, so the agent preserves
      // spend meter, violations, familiarity, deja-vu, and runtime config across reboots.
      const entrypoint = plasticMode ? '--entrypoint gro-supervised' : '';
      const podmanBase = `podman run -it --rm --network host ${volMount} ${devMount} ${envFlags} ${entrypoint} thesystem-gro:latest --autodiscover-mcp`;

      let runScript: string;
      if (plasticMode) {
        // PLASTIC mode: the supervisor handles restart-on-exit-75 internally with
        // warm state preservation. No bash restart loop needed.
        console.log('[thesystem] PLASTIC mode: self-modification enabled, supervisor handles warm restarts');
        const groCmd = noContinue
          ? `${podmanBase} -i --plastic${extraArgs}`
          : `${podmanBase} -c --plastic${extraArgs} || ${podmanBase} -i --plastic${extraArgs}`;
        runScript = `${volSetup} && ${groCmd}`;
      } else if (noContinue) {
        runScript = `${volSetup} && ${podmanBase} -i${extraArgs}`;
      } else {
        // Try -c first; if it fails (no session), retry with -i
        runScript = `${volSetup} && ${podmanBase} -c${extraArgs} || ${podmanBase} -i${extraArgs}`;
      }

      const runChild = spawn('limactl', ['shell', '--workdir', '/home', vmName, 'bash', '-c', runScript], {
        stdio: 'inherit',
      });
      await new Promise<void>((resolve, reject) => {
        runChild.on('close', (code) => {
          if (code !== 0 && code !== null) reject(new Error(`gro exited with code ${code}`));
          else resolve();
        });
        runChild.on('error', reject);
      });
      break;
    }

    case 'gtui': {
      // Run gtui (TUI for gro) in a podman container inside the VM.
      // gtui spawns gro internally, so the container needs both packages.
      // Usage: thesystem gtui [gtui-args...]
      //   e.g. thesystem gtui --provider openai --model gpt-4.1
      //        thesystem gtui --rebuild       (force rebuild container image)
      const vmName = 'thesystem';
      const rebuild = args.includes('--rebuild');
      const devMode = args.includes('--dev');
      const gtuiArgs = args.slice(1).filter(a => a !== '--' && a !== '--rebuild' && a !== '--dev');

      const orchestrator = new Orchestrator();
      const running = await orchestrator.isVmRunning();
      if (!running) {
        console.error('[thesystem] VM is not running. Start it first: thesystem start');
        process.exit(1);
      }

      // Check agentauth proxy is healthy
      const proxyPort = process.env.AGENTAUTH_PORT || '9999';
      try {
        await exec('/usr/bin/curl', ['-sf', `http://localhost:${proxyPort}/agentauth/health`], { timeout: 2000 });
      } catch {
        console.error(`[thesystem] agentauth proxy not running on :${proxyPort}. Run: thesystem agentauth start`);
        process.exit(1);
      }

      // Ensure wormhole relay is running (non-blocking — pods can work without it)
      const wormholePort = process.env.WORMHOLE_PORT || '8787';
      try {
        const { stdout: httpCode } = await exec('/usr/bin/curl', ['-so', '/dev/null', '-w', '%{http_code}', `http://localhost:${wormholePort}/`], { timeout: 2000 });
        if (httpCode.trim() !== '000') console.log(`[thesystem] wormhole relay on :${wormholePort}`);
        else throw new Error('not running');
      } catch {
        try {
          await exec('which', ['wormhole'], { timeout: 2000 });
          console.log('[thesystem] Starting wormhole relay...');
          const wormholeChild = spawn('wormhole', ['relay', '-r', wormholePort], {
            detached: true, stdio: 'ignore', env: { ...process.env },
          });
          wormholeChild.unref();
          await new Promise(r => setTimeout(r, 1500));
          console.log(`[thesystem] wormhole relay started on :${wormholePort}`);
        } catch {
          console.log('[thesystem] wormhole not installed — skipping relay (npm i -g @tjamescouch/wormhole)');
        }
      }

      // Build container image (includes both gro and gtui)
      const imageCheck = rebuild ? 'false' : 'podman image exists thesystem-gtui:latest 2>/dev/null';
      const buildScript = [
        'export PATH="$HOME/.npm-global/bin:$PATH"',
        `if ! ${imageCheck}; then`,
        `  echo '[thesystem] Building gtui container image...'`,
        `  podman build --no-cache -t thesystem-gtui:latest -f- /tmp <<'CONTAINERFILE_EOF'`,
        'FROM node:20-slim',
        'RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*',
        'RUN npm install -g @tjamescouch/gro @tjamescouch/gtui agentpatch @tjamescouch/wormhole && npm cache clean --force',
        'USER node',
        'WORKDIR /home/node',
        'ENTRYPOINT ["gtui"]',
        'CONTAINERFILE_EOF',
        `  echo '[thesystem] Image built.'`,
        'else',
        `  echo '[thesystem] Image ready.'`,
        'fi',
      ].join('\n');

      const buildChild = spawn('limactl', ['shell', '--workdir', '/home', vmName, 'bash', '-c', buildScript], {
        stdio: 'inherit',
      });
      await new Promise<void>((resolve, reject) => {
        buildChild.on('close', (code) => {
          if (code !== 0) reject(new Error(`Image build failed with code ${code}`));
          else resolve();
        });
        buildChild.on('error', reject);
      });

      // Build env flags for all provider proxies
      const gtuiProxyBase = `http://host.lima.internal:${proxyPort}`;
      const gtuiEnvPairs: [string, string][] = [
        ['ANTHROPIC_BASE_URL', `${gtuiProxyBase}/anthropic`],
        ['ANTHROPIC_API_KEY', 'proxy-managed'],
        ['OPENAI_BASE_URL', `${gtuiProxyBase}/openai`],
        ['OPENAI_API_KEY', 'proxy-managed'],
        ['XAI_BASE_URL', `${gtuiProxyBase}/xai`],
        ['XAI_API_KEY', 'proxy-managed'],
        ['GROQ_BASE_URL', `${gtuiProxyBase}/groq`],
        ['GROQ_API_KEY', 'proxy-managed'],
        ['GOOGLE_BASE_URL', `${gtuiProxyBase}/google`],
        ['GOOGLE_API_KEY', 'proxy-managed'],
        ['DEEPSEEK_BASE_URL', `${gtuiProxyBase}/deepseek`],
        ['DEEPSEEK_API_KEY', 'proxy-managed'],
        ['MISTRAL_BASE_URL', `${gtuiProxyBase}/mistral`],
        ['MISTRAL_API_KEY', 'proxy-managed'],
        ['WORMHOLE_RELAY', `http://host.lima.internal:${wormholePort}`],
      ];
      const gtuiEnvFlags = gtuiEnvPairs.map(([k, v]) => `-e ${k}=${v}`).join(' ');

      // Reuse gro's volume for session persistence (gtui spawns gro internally)
      const gtuiVolSetup = `podman volume exists thesystem-gro 2>/dev/null || podman volume create thesystem-gro`;
      const gtuiVolMount = `-v thesystem-gro:/home/node/.gro`;

      // --dev: bind-mount host gro + gtui source over the container's global installs.
      const gtuiDevMount = devMode
        ? `-v /home/jamescouch.linux/dev/gro:/usr/local/lib/node_modules/@tjamescouch/gro:ro -v /home/jamescouch.linux/dev/claude/gtui:/usr/local/lib/node_modules/@tjamescouch/gtui:ro`
        : '';
      if (devMode) console.log('[thesystem] Dev mode: mounting host gro+gtui source into container');

      const escapedGtuiArgs = gtuiArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const gtuiExtraArgs = gtuiArgs.length > 0 ? ` ${escapedGtuiArgs}` : '';
      const gtuiRunScript = `${gtuiVolSetup} && podman run -it --rm --network host ${gtuiVolMount} ${gtuiDevMount} ${gtuiEnvFlags} thesystem-gtui:latest${gtuiExtraArgs}`;

      const gtuiRunChild = spawn('limactl', ['shell', '--workdir', '/home', vmName, 'bash', '-c', gtuiRunScript], {
        stdio: 'inherit',
      });
      await new Promise<void>((resolve, reject) => {
        gtuiRunChild.on('close', (code) => {
          if (code !== 0 && code !== null) reject(new Error(`gtui exited with code ${code}`));
          else resolve();
        });
        gtuiRunChild.on('error', reject);
      });
      break;
    }

    case 'go': {
      // Open an interactive shell inside the VM.
      // Uses --workdir /home to avoid the Lima cwd-mount issue (Lima maps your
      // host cwd into the VM, which fails if the directory isn't mounted).
      const vmName = 'thesystem';
      const child = spawn('limactl', ['shell', '--workdir', '/home', vmName], {
        stdio: 'inherit',
      });
      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`shell exited with code ${code}`));
          else resolve();
        });
        child.on('error', reject);
      });
      break;
    }

    case 'agentctl': {
      // Forward agentctl commands into the VM with proper environment.
      // Usage: thesystem agentctl start Samantha "Hi Samantha"
      //        thesystem agentctl -- start Samantha "Hi Samantha"
      const vmName = 'thesystem';
      const agentctlArgs = args.slice(1).filter(a => a !== '--');

      if (agentctlArgs.length === 0) {
        console.error('Usage: thesystem agentctl <command> [args...]');
        console.error('Example: thesystem agentctl start Samantha "Hi Samantha"');
        process.exit(1);
      }

      const orchestrator = new Orchestrator();
      const running = await orchestrator.isVmRunning();
      if (!running) {
        console.error('[thesystem] VM is not running. Start it first: thesystem start');
        process.exit(1);
      }

      const proxyPort = process.env.AGENTAUTH_PORT || '9999';
      const envSetup = [
        'export PATH="$HOME/.npm-global/bin:$PATH"',
        `export ANTHROPIC_BASE_URL='http://host.lima.internal:${proxyPort}/anthropic'`,
        `export ANTHROPIC_API_KEY='proxy-managed'`,
        `export AGENTCHAT_PUBLIC=true`,
        // Read token from thesystem start if available
        'if [ -f /run/thesystem/agent-token ]; then export CLAUDE_CODE_OAUTH_TOKEN=$(cat /run/thesystem/agent-token); fi',
      ].join('; ');

      const escapedArgs = agentctlArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const cmd = `${envSetup}; exec agentctl ${escapedArgs}`;

      const agentctlChild = spawn('limactl', ['shell', '--workdir', '/home', vmName, 'bash', '-c', cmd], {
        stdio: 'inherit',
      });
      await new Promise<void>((resolve, reject) => {
        agentctlChild.on('close', (code) => {
          if (code !== 0) reject(new Error(`agentctl exited with code ${code}`));
          else resolve();
        });
        agentctlChild.on('error', reject);
      });
      break;
    }

    case 'help':
    default: {
      printUsage();
      break;
    }
  }
}

main().catch((err) => {
  console.error('[thesystem] Fatal error:', err.message);
  process.exit(1);
});
