#!/usr/bin/env node

import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadConfig, writeDefaultConfig } from './config-loader';
import { Orchestrator } from './orchestrator';
import { ComponentStatus } from './types';

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
  thesystem help          Show this message
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
