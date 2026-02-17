#!/usr/bin/env node

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
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
  thesystem init          Create thesystem.yaml with defaults
  thesystem start         Boot Lima VM and all services
  thesystem stop          Graceful shutdown (services + VM)
  thesystem status        Show component status
  thesystem destroy       Delete VM (rebuild from scratch on next start)
  thesystem doctor        Check prerequisites and health
  thesystem config        Show resolved configuration
  thesystem logs [svc]    Tail logs from a service (server, dashboard, swarm)
  thesystem version       Show version
  thesystem reinstall     Reinstall components inside VM
  thesystem go            Open an interactive shell inside the VM
  thesystem keys set      Store API keys in macOS Keychain
  thesystem keys get      Read API keys from macOS Keychain (prints to stdout)
  thesystem agentauth     Run local agentauth proxy (required for swarm)
  thesystem help          Show this message

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

      process.on('SIGINT', async () => {
        console.log('\n[thesystem] Caught SIGINT, shutting down...');
        await orchestrator.stop();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        console.log('\n[thesystem] Caught SIGTERM, shutting down...');
        await orchestrator.stop();
        process.exit(0);
      });

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
      // Store config so getStatus can read ports
      (orchestrator as any).config = config;
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
      const envSecrets = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_TOKEN_BEARER']
        .filter(k => !!process.env[k]);
      if (envSecrets.length) {
        console.log(`  API auth ... FAIL (secrets present in env: ${envSecrets.join(', ')})`);
        console.log('           Use: thesystem keys set <provider> <key>  (stores in macOS Keychain)');
        console.log('           Then: thesystem agentauth start');
      } else {
        console.log('  API auth ... ok (no secrets in env)');
        console.log('           Note: swarm still requires agentauth proxy healthy on localhost:9999');
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
      await startAgentAuthProxy({ port });
      break;
    }

    case 'logs': {
      const svc = args[1] || 'server';
      const logMap: Record<string, string> = {
        server: '/tmp/agentchat-server.log',
        dashboard: '/tmp/agentdash.log',
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
