#!/usr/bin/env node

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, writeDefaultConfig } from './config-loader';
import { Orchestrator } from './orchestrator';
import { ComponentStatus } from './types';

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
  thesystem help                Show this message
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
      const configPath = writeDefaultConfig(process.cwd());
      console.log(`Created ${configPath}`);
      console.log('Edit the file to customize, then run: thesystem start');
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
        } else if (created) {
          console.log('  VM ... stopped (run: thesystem start)');
        } else {
          console.log('  VM ... not created (run: thesystem start)');
        }
      }

      console.log('\n[thesystem] Diagnostics complete.');
      break;
    }

    case 'logs': {
      const svc = args[1] || 'server';
      const logMap: Record<string, string> = {
        server: '/tmp/agentchat-server.log',
        dashboard: '/tmp/agentchat-dashboard.log',
        swarm: '/tmp/agentctl-swarm.log',
      };
      const logFile = logMap[svc];
      if (!logFile) {
        console.error(`Unknown service "${svc}". Options: server, dashboard, swarm`);
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
