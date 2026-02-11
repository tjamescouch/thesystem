import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { SystemConfig, ComponentStatus } from './types';

const exec = promisify(execFile);

const VM_NAME = 'thesystem';

export class Orchestrator {
  private config: SystemConfig | null = null;

  private async limactl(args: string[], timeout = 300000): Promise<string> {
    const { stdout } = await exec('limactl', args, { timeout });
    return stdout.trim();
  }

  private async shell(command: string, timeout = 30000): Promise<string> {
    // Write command to a temp script, execute it, clean up
    const scriptName = `.thesystem-cmd-${Date.now()}.sh`;
    const script = `#!/bin/bash\nexport PATH="$HOME/.npm-global/bin:$PATH"\n${command}\n`;

    // Write script via limactl shell (simple echo, no backgrounding)
    await exec('limactl', ['shell', '--workdir', '/home', VM_NAME,
      'bash', '-c', `cat > /tmp/${scriptName} << 'THESYSTEM_EOF'\n${script}THESYSTEM_EOF`
    ], { timeout: 10000 });

    // Execute and capture output
    const { stdout } = await exec('limactl', ['shell', '--workdir', '/home', VM_NAME,
      'bash', `/tmp/${scriptName}`
    ], { timeout });

    // Cleanup
    exec('limactl', ['shell', '--workdir', '/home', VM_NAME,
      'rm', '-f', `/tmp/${scriptName}`
    ]).catch(() => {});

    return stdout.trim();
  }

  async isVmRunning(): Promise<boolean> {
    try {
      const output = await this.limactl(['list', '--json']);
      const lines = output.split('\n').filter(Boolean);
      for (const line of lines) {
        const vm = JSON.parse(line);
        if (vm.name === VM_NAME && vm.status === 'Running') return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async isVmCreated(): Promise<boolean> {
    try {
      const output = await this.limactl(['list', '--json']);
      const lines = output.split('\n').filter(Boolean);
      for (const line of lines) {
        const vm = JSON.parse(line);
        if (vm.name === VM_NAME) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  generateLimaYaml(config: SystemConfig): string {
    const templatePath = process.env.THESYSTEM_LIMA_TEMPLATE
      || path.join(__dirname, '..', 'lima', 'thesystem.yaml');

    if (!fs.existsSync(templatePath)) {
      throw new Error(`Lima template not found at ${templatePath}`);
    }

    const template = fs.readFileSync(templatePath, 'utf-8');
    const doc = YAML.parse(template);

    doc.cpus = config.vm.cpus;
    doc.memory = config.vm.memory;
    doc.disk = config.vm.disk;

    if (doc.mounts && doc.mounts[0]) {
      doc.mounts[0].location = config.vm.mount;
    }

    // Port forwards for server mode
    if (config.mode === 'server') {
      doc.portForwards = [
        { guestPort: config.server.port, hostPort: config.server.port },
        { guestPort: config.server.dashboard, hostPort: config.server.dashboard },
      ];
    }

    // Pass config as env vars for provisioning scripts
    doc.env = {
      THESYSTEM_MODE: config.mode,
      THESYSTEM_SERVER_PORT: String(config.server.port),
      THESYSTEM_DASHBOARD_PORT: String(config.server.dashboard),
      THESYSTEM_ALLOWLIST: String(config.server.allowlist),
      THESYSTEM_REMOTE: config.client.remote,
      THESYSTEM_SWARM_AGENTS: String(config.swarm.agents),
      THESYSTEM_SWARM_BACKEND: config.swarm.backend,
      THESYSTEM_CHANNELS: config.channels.join(','),
    };

    return YAML.stringify(doc, { lineWidth: 0 });
  }

  async start(config: SystemConfig): Promise<void> {
    this.config = config;
    const running = await this.isVmRunning();

    if (running) {
      console.log(`[thesystem] VM "${VM_NAME}" already running.`);
      console.log('[thesystem] Starting services...');
      await this.startServices(config);
      return;
    }

    const created = await this.isVmCreated();

    if (created) {
      console.log(`[thesystem] Starting VM "${VM_NAME}"...`);
      await this.limactl(['start', VM_NAME], 600000);
    } else {
      console.log(`[thesystem] Creating VM "${VM_NAME}"...`);
      console.log('[thesystem] First run — this will take a few minutes.');

      const yamlContent = this.generateLimaYaml(config);
      const tmpYaml = path.join(process.env.TMPDIR || '/tmp', `thesystem-${Date.now()}.yaml`);
      fs.writeFileSync(tmpYaml, yamlContent);

      try {
        await this.limactl(['create', '--name', VM_NAME, tmpYaml], 600000);
        await this.limactl(['start', VM_NAME], 600000);
      } finally {
        fs.unlinkSync(tmpYaml);
      }
    }

    console.log('[thesystem] VM running. Starting services...');
    await this.startServices(config);
  }

  private async installIfNeeded(config: SystemConfig): Promise<void> {
    // Always need agentchat
    try {
      await this.shell('which agentchat', 5000);
    } catch {
      console.log('[thesystem] Installing agentchat (first run)...');
      await this.shell(
        'npm install -g @tjamescouch/agentchat',
        300000
      );
    }

    // Server mode: also need the dashboard
    if (config.mode === 'server') {
      try {
        await this.shell('test -d ~/.thesystem/services/dashboard', 5000);
      } catch {
        console.log('[thesystem] Cloning and building dashboard...');
        await this.shell(
          'git clone https://github.com/tjamescouch/agentchat-dashboard.git ~/.thesystem/services/dashboard',
          120000
        );
        await this.shell(
          'cd ~/.thesystem/services/dashboard/server && npm install && npx tsc',
          120000
        );
        await this.shell(
          'cd ~/.thesystem/services/dashboard/web && npm install && npm run build',
          120000
        );
      }
    }

    // Both modes: need theswarm for spawning agents
    try {
      await this.shell('which agentctl', 5000);
    } catch {
      console.log('[thesystem] Installing theswarm...');
      // Install from host-mounted dev directory if available, else clone
      try {
        await this.shell('test -d ~/dev/claude/agent-006/agentctl-swarm', 5000);
        await this.shell(
          'cd ~/dev/claude/agent-006/agentctl-swarm && npm install -g .',
          120000
        );
      } catch {
        await this.shell(
          'git clone https://github.com/tjamescouch/agentctl-swarm.git ~/.thesystem/services/theswarm && cd ~/.thesystem/services/theswarm && npm install -g .',
          120000
        );
      }
    }

    // Both modes: need claude CLI for agents
    try {
      await this.shell('which claude', 5000);
    } catch {
      console.log('[thesystem] Installing Claude Code CLI...');
      await this.shell(
        'npm install -g @anthropic-ai/claude-code',
        300000
      );
    }

    console.log('[thesystem] Installation complete.');
  }

  private async startServices(config: SystemConfig): Promise<void> {
    await this.installIfNeeded(config);

    // Kill any leftover processes from previous runs
    await this.shell('pkill -f "agentchat serve" 2>/dev/null || true; pkill -f "dashboard/server" 2>/dev/null || true; pkill -f "agentctl start" 2>/dev/null || true; sleep 1');

    if (config.mode === 'server') {
      console.log('[thesystem] Starting agentchat-server...');
      await this.daemonize(
        `agentchat serve --port ${config.server.port} --host 0.0.0.0`,
        '/tmp/agentchat-server.log'
      );
      await this.waitForPort(config.server.port, 30000);

      console.log('[thesystem] Starting agentchat-dashboard...');
      await this.daemonize(
        `cd ~/.thesystem/services/dashboard/server && AGENTCHAT_WS_URL=ws://localhost:${config.server.port} PORT=${config.server.dashboard} node dist/index.js`,
        '/tmp/agentchat-dashboard.log'
      );
      await this.waitForPort(config.server.dashboard);
    }

    // Start TheSwarm (both modes)
    const serverUrl = config.mode === 'server'
      ? `ws://localhost:${config.server.port}`
      : config.client.remote;
    const channels = config.channels.join(',');

    console.log(`[thesystem] Starting theswarm (${config.swarm.agents} agents)...`);
    await this.daemonize(
      `agentctl start --server ${serverUrl} --count ${config.swarm.agents} --channels ${channels} --role ${config.swarm.backend}`,
      '/tmp/agentctl-swarm.log'
    );
  }

  private async daemonize(command: string, logFile: string): Promise<void> {
    // Use setsid to create a new session, close all inherited FDs,
    // and redirect stdin from /dev/null so the SSH session can exit cleanly.
    const wrapper = `setsid bash -c 'exec > ${logFile} 2>&1 < /dev/null; ${command}' &`;
    await this.shell(wrapper);
    // Brief pause to let the process start
    await new Promise(r => setTimeout(r, 500));
  }

  private async waitForPort(port: number, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        // Use host-side check since ports are forwarded
        await exec('curl', ['-s', '-o', '/dev/null', '-w', '', `http://localhost:${port}`], { timeout: 3000 });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    console.log(`[thesystem] Warning: port ${port} not ready after ${timeoutMs}ms`);
  }

  async stop(): Promise<void> {
    const running = await this.isVmRunning();
    if (!running) {
      console.log(`[thesystem] VM "${VM_NAME}" is not running.`);
      return;
    }

    console.log('[thesystem] Stopping services...');
    const stopPatterns = [
      { name: 'theswarm', grep: 'agentctl start' },
      { name: 'agentchat-dashboard', grep: 'dashboard/server' },
      { name: 'agentchat-server', grep: 'agentchat serve' },
    ];
    for (const proc of stopPatterns) {
      try {
        await this.shell(`pkill -f "${proc.grep}" 2>/dev/null || true`);
        console.log(`[thesystem] Stopped ${proc.name}.`);
      } catch {
        // May not be running
      }
    }

    console.log(`[thesystem] Stopping VM...`);
    await this.limactl(['stop', VM_NAME], 60000);
    console.log('[thesystem] Stopped.');
  }

  async destroy(): Promise<void> {
    const created = await this.isVmCreated();
    if (!created) {
      console.log(`[thesystem] VM "${VM_NAME}" does not exist.`);
      return;
    }

    const running = await this.isVmRunning();
    if (running) {
      console.log('[thesystem] Stopping VM first...');
      await this.limactl(['stop', VM_NAME], 60000);
    }

    console.log(`[thesystem] Deleting VM "${VM_NAME}"...`);
    await this.limactl(['delete', VM_NAME], 60000);
    console.log('[thesystem] Destroyed. Run "thesystem start" to rebuild.');
  }

  async getStatus(): Promise<ComponentStatus[]> {
    const running = await this.isVmRunning();
    if (!running) {
      return [{ name: 'vm', version: '-', port: null, pid: null, status: 'stopped', restarts: 0 }];
    }

    const components: ComponentStatus[] = [
      { name: 'vm', version: 'Ubuntu 24.04', port: null, pid: null, status: 'running', restarts: 0 },
    ];

    const services = [
      { name: 'agentchat-server', grep: 'agentchat serve' },
      { name: 'agentchat-dashboard', grep: 'dashboard/server' },
      { name: 'theswarm', grep: 'agentctl start' },
    ];

    for (const svc of services) {
      try {
        const pid = await this.shell(`pgrep -f "${svc.grep}" | head -1`);
        const port = svc.name === 'agentchat-server' ? (this.config?.server.port ?? 6667)
          : svc.name === 'agentchat-dashboard' ? (this.config?.server.dashboard ?? 3000)
          : null;

        components.push({
          name: svc.name,
          version: '-',
          port,
          pid: pid ? parseInt(pid, 10) : null,
          status: pid ? 'running' : 'stopped',
          restarts: 0,
        });
      } catch {
        components.push({
          name: svc.name, version: '-', port: null, pid: null, status: 'stopped', restarts: 0,
        });
      }
    }

    return components;
  }
}
