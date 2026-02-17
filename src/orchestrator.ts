import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { SystemConfig, ComponentStatus } from './types';

const exec = promisify(execFile);

const VM_NAME = 'thesystem';

/** Env var names that contain secrets — NEVER forward into the VM */
const SECRET_ENV_VARS = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_TOKEN_BEARER',
]);

/** Default agentauth proxy port */
const AGENTAUTH_PORT = 9999;

export class Orchestrator {
  private config: SystemConfig | null = null;

  private async limactl(args: string[], timeout = 300000): Promise<string> {
    const { stdout } = await exec('limactl', args, { timeout });
    return stdout.trim();
  }

  private async shell(command: string, timeout = 30000): Promise<string> {
    // Write command to a temp script, execute it, clean up
    const scriptName = `.thesystem-cmd-${Date.now()}.sh`;

    // Forward host env vars matching known prefixes into the VM script
    // SECURITY: Strip vars containing secrets — agents use agentauth proxy instead
    const envForwardRegex = /^(ANTHROPIC_|THESYSTEM_|AGENTCHAT_|CLAUDE_CODE_)/;
    const envExports = Object.entries(process.env)
      .filter(([k]) => envForwardRegex.test(k) && !SECRET_ENV_VARS.has(k))
      .map(([k, v]) => `export ${k}='${(v || '').replace(/'/g, "'\\''")}'`)
      .join('\n');

    // Inject proxy URLs so agents route through agentauth.
    const proxyPort = process.env.AGENTAUTH_PORT || String(AGENTAUTH_PORT);
    const proxyExports = [
      `export ANTHROPIC_BASE_URL='http://host.lima.internal:${proxyPort}/anthropic'`,
      `export ANTHROPIC_API_KEY='proxy-managed'`,
      `export OPENAI_BASE_URL='http://host.lima.internal:${proxyPort}/openai'`,
      `export OPENAI_API_KEY='proxy-managed'`,
    ].join('\n');

    const script = `#!/bin/bash\nexport PATH="$HOME/.npm-global/bin:$PATH"\n${envExports}\n${proxyExports}\n${command}\n`;

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
      AGENTCHAT_SERVER: `ws://localhost:${config.server.port}`,
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

  /**
   * Ensure npm global bin is on PATH in interactive shells.
   * Idempotent — safe to call on every reinstall.
   */
  private async ensureNpmPath(): Promise<void> {
    await this.shell(
      `mkdir -p ~/.bashrc.d && ` +
      `grep -q 'npm-global' ~/.bashrc.d/10-thesystem-prompt.sh 2>/dev/null || ` +
      `echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc.d/10-thesystem-prompt.sh`,
      10000
    ).catch(() => {}); // Best effort
  }

  private async installIfNeeded(): Promise<void> {
    await this.ensureNpmPath();

    try {
      await this.shell('which agentchat', 5000);
      return; // Already installed
    } catch {
      // Need to install
    }

    console.log('[thesystem] First run detected — installing components...');
    console.log('[thesystem] This takes 3-5 minutes. Grab a coffee. ☕\n');

    const steps = [
      {
        name: 'agentchat server',
        cmd: 'npm install -g @tjamescouch/agentchat',
        timeout: 300000,
      },
      {
        name: 'agentctl-swarm',
        cmd: 'npm install -g agentctl-swarm',
        timeout: 300000,
      },
      {
        name: 'claude-code runtime',
        cmd: 'npm install -g @anthropic-ai/claude-code',
        timeout: 300000,
      },
      {
        name: 'gro runtime',
        cmd: 'npm install -g @tjamescouch/gro',
        timeout: 300000,
      },
      {
        name: 'niki supervisor',
        cmd: 'npm install -g @tjamescouch/niki',
        timeout: 300000,
      },
      {
        name: 'agentctl.sh script',
        cmd: 'curl -fsSL https://raw.githubusercontent.com/tjamescouch/agentchat/main/lib/supervisor/agentctl.sh -o /tmp/agentctl && sudo mv /tmp/agentctl /usr/local/bin/agentctl && sudo chmod +x /usr/local/bin/agentctl',
        timeout: 60000,
      },
      {
        name: 'dashboard (clone)',
        cmd: 'git clone https://github.com/tjamescouch/agentdash.git ~/.thesystem/services/dashboard',
        timeout: 120000,
      },
      {
        name: 'dashboard server (build)',
        cmd: 'cd ~/.thesystem/services/dashboard/server && npm install && npx tsc',
        timeout: 120000,
      },
      {
        name: 'dashboard web (build)',
        cmd: 'cd ~/.thesystem/services/dashboard/web && npm install && npm run build',
        timeout: 120000,
      },
    ];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const progress = `[${i + 1}/${steps.length}]`;
      console.log(`  ${progress} Installing ${step.name}...`);
      try {
        await this.shell(step.cmd, step.timeout);
        console.log(`  ${progress} ✓ ${step.name}`);
      } catch (err: any) {
        console.error(`  ${progress} ✗ ${step.name} — ${err.message}`);
        console.error(`\n[thesystem] Installation failed at step ${i + 1}.`);
        console.error('[thesystem] Fix the issue and run: thesystem start');
        console.error('[thesystem] Or start fresh: thesystem destroy && thesystem start');
        throw err;
      }
    }

    console.log('\n[thesystem] ✓ All components installed.');
  }

  private async startServices(config: SystemConfig): Promise<void> {
    await this.installIfNeeded();

    // Kill any leftover processes from previous runs
    await this.shell('pkill -f "agentchat serve" 2>/dev/null || true; pkill -f "dashboard/server" 2>/dev/null || true; sleep 1');

    if (config.mode === 'server') {
      console.log('[thesystem] Starting agentchat-server...');
      await this.daemonize(
        `agentchat serve --port ${config.server.port} --host 0.0.0.0`,
        '/tmp/agentchat-server.log'
      );
      await this.waitForPort(config.server.port, 30000);

      console.log('[thesystem] Starting agentdash...');
      await this.daemonize(
        `cd ~/.thesystem/services/dashboard/server && AGENTCHAT_WS_URL=ws://localhost:${config.server.port} PORT=${config.server.dashboard} node dist/index.js`,
        '/tmp/agentdash.log'
      );
      await this.waitForPort(config.server.dashboard);
    }

    // Start agent swarm if configured
    if (config.swarm.agents > 0) {
      // Guard: require agentauth proxy running on the host.
      // SECURITY: do not support env-var auth fallback by default (exfil risk).
      const proxyPort = process.env.AGENTAUTH_PORT || String(AGENTAUTH_PORT);
      let proxyOk = false;
      try {
        await exec('curl', ['-sf', `http://localhost:${proxyPort}/agentauth/health`], { timeout: 3000 });
        proxyOk = true;
      } catch {
        // Proxy not running
      }

      if (!proxyOk) {
        console.error('[thesystem] ERROR: agentauth proxy not running on localhost:' + proxyPort);
        console.error('[thesystem] Start it first: thesystem agentauth start');
        console.error('[thesystem] Agents need API access via proxy. Skipping swarm startup.');
        return;
      }

      console.log(`[thesystem] agentauth proxy detected on :${proxyPort}`);
      console.log(`[thesystem] Starting swarm (${config.swarm.agents} agents)...`);
      await this.daemonize(
        `agentctl start --count ${config.swarm.agents} --channels ${config.channels.join(',')}`,
        '/tmp/agentctl-swarm.log'
      );
      console.log('[thesystem] Swarm started.');
    }
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
      { name: 'agentctl-swarm', grep: 'agentctl-swarm' },
      { name: 'agentdash', grep: 'dashboard/server' },
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

  /**
   * Force reinstall all components inside the VM.
   * Useful for recovery when installIfNeeded() failed partway.
   */
  async reinstall(): Promise<void> {
    console.log('[thesystem] Cleaning previous installation...');
    await this.shell('rm -rf ~/.thesystem/services/dashboard', 30000).catch(() => {});
    await this.shell('npm uninstall -g @tjamescouch/agentchat agentctl-swarm @anthropic-ai/claude-code 2>/dev/null || true', 30000).catch(() => {});
    await this.ensureNpmPath();
    console.log('[thesystem] Clean. Running fresh install...');
    await this.installIfNeeded();
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
      { name: 'agentdash', grep: 'dashboard/server' },
      { name: 'agentctl-swarm', grep: 'agentctl-swarm' },
    ];

    for (const svc of services) {
      try {
        const pid = await this.shell(`pgrep -f "${svc.grep}" | head -1`);
        const port = svc.name === 'agentchat-server' ? (this.config?.server.port ?? 6667)
          : svc.name === 'agentdash' ? (this.config?.server.dashboard ?? 3000)
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
