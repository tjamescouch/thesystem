import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { SystemConfig, ComponentStatus } from './types';
import { createSecretStore } from './secret-store';

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

  /** Set config for use by getStatus() and other methods that need port info */
  setConfig(config: SystemConfig): void {
    this.config = config;
  }

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
    ]).catch((err) => {
      console.warn(`[thesystem] Cleanup of temp script failed: ${err.message}`);
    });

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

  private async installIfNeeded(config: SystemConfig): Promise<void> {
    await this.ensureNpmPath();

    // Always need agentchat
    try {
      await this.shell('which agentchat', 5000);
      // Update to latest if already installed
      console.log('[thesystem] Checking agentchat for updates...');
      try {
        await this.shell('npm update -g @tjamescouch/agentchat', 60000);
      } catch {
        console.warn('[thesystem] agentchat update check failed, continuing with installed version.');
      }
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
        // Update dashboard to latest
        console.log('[thesystem] Checking dashboard for updates...');
        try {
          await this.shell(
            'cd ~/.thesystem/services/dashboard && git pull --ff-only && cd server && npm install && npx tsc && cd ../web && npm install && npm run build',
            120000
          );
        } catch {
          console.warn('[thesystem] Dashboard update failed, continuing with installed version.');
        }
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
      // Update theswarm if installed from git clone
      console.log('[thesystem] Checking theswarm for updates...');
      try {
        await this.shell(
          'test -d ~/.thesystem/services/theswarm && cd ~/.thesystem/services/theswarm && git pull --ff-only && npm install -g .',
          60000
        );
      } catch {
        console.warn('[thesystem] theswarm update check failed, continuing with installed version.');
      }
    } catch {
      console.log('[thesystem] Installing theswarm...');
      // Install from host-mounted dev directory if available (set THESYSTEM_SWARM_DEV_PATH), else clone
      const swarmDevPath = process.env.THESYSTEM_SWARM_DEV_PATH;
      let installedFromDev = false;
      if (swarmDevPath) {
        try {
          await this.shell(`test -d ${swarmDevPath}`, 5000);
          await this.shell(`cd ${swarmDevPath} && npm install -g .`, 120000);
          installedFromDev = true;
        } catch {
          console.log(`[thesystem] Dev path ${swarmDevPath} not found, falling back to git clone...`);
        }
      }
      if (!installedFromDev) {
        await this.shell(
          'git clone https://github.com/tjamescouch/agentctl-swarm.git ~/.thesystem/services/theswarm && cd ~/.thesystem/services/theswarm && npm install -g .',
          120000
        );
      }
    }

    // Both modes: need claude CLI for agents
    try {
      await this.shell('which claude', 5000);
      console.log('[thesystem] Checking Claude Code CLI for updates...');
      try {
        await this.shell('npm update -g @anthropic-ai/claude-code', 60000);
      } catch {
        console.warn('[thesystem] Claude Code CLI update check failed, continuing with installed version.');
      }
    } catch {
      console.log('[thesystem] Installing Claude Code CLI...');
      await this.shell(
        'npm install -g @anthropic-ai/claude-code',
        300000
      );
    }

    console.log('[thesystem] Installation complete.');
  }

  private async ensureAgentAuthProxy(): Promise<void> {
    const proxyPort = process.env.AGENTAUTH_PORT || String(AGENTAUTH_PORT);
    const url = `http://localhost:${proxyPort}/agentauth/health`;

    // Check if already running
    try {
      await exec('curl', ['-sf', url], { timeout: 2000 });
      return; // Already up
    } catch {
      // Not running — auto-start it
    }

    console.log('[thesystem] Starting agentauth proxy...');
    const thesystem = process.execPath === process.argv[0]
      ? process.argv[1]  // running as `node cli.js`
      : process.argv[0]; // running as compiled binary

    const child = spawn(process.execPath, [thesystem, 'agentauth', 'start'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();

    // Wait for proxy to become healthy (up to 10s)
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      try {
        await exec('curl', ['-sf', url], { timeout: 1000 });
        return; // Up
      } catch {
        // Still starting
      }
    }
    throw new Error(`agentauth proxy failed to start on port ${proxyPort}. Run: thesystem agentauth start`);
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
        '/tmp/agentdash.log'
      );
      await this.waitForPort(config.server.dashboard);
    }

    // Start TheSwarm (both modes)
    // Retrieve API credentials from secret store (keychain/libsecret/aes-file)
    const secrets = await createSecretStore();
    let token = await secrets.get('oauth-token');
    if (!token) {
      // Fallback: check environment variables
      token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || null;
    }
    if (!token) {
      console.error('[thesystem] ERROR: No API credentials found.');
      console.error('[thesystem] Store credentials: thesystem secrets set oauth-token <your-token>');
      console.error('[thesystem] Or set env var: export ANTHROPIC_API_KEY=sk-ant-...');
      console.error('[thesystem] Skipping swarm startup. Server and dashboard are still running.');
      return;
    }

    // Write token to a tmpfs file inside the VM, readable only by agent user
    const tokenVar = token.startsWith('sk-ant-') ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
    await this.shell(`mkdir -p /run/thesystem && echo -n '${token.replace(/'/g, "'\\''")}' > /run/thesystem/agent-token && chmod 600 /run/thesystem/agent-token`);

    const serverUrl = config.mode === 'server'
      ? `ws://localhost:${config.server.port}`
      : config.client.remote;
    const channels = config.channels.join(',');

    console.log(`[thesystem] Starting theswarm (${config.swarm.agents} agents)...`);
    await this.daemonize(
      `export ${tokenVar}=$(cat /run/thesystem/agent-token) && agentctl start --server ${serverUrl} --count ${config.swarm.agents} --channels ${channels} --role ${config.swarm.backend}`,
      '/tmp/agentctl-swarm.log'
    );
    console.log('[thesystem] Swarm started.');
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
    // Load config for reinstall — use stored config if available, else load from disk
    const config = this.config || (() => {
      const { loadConfig } = require('./config-loader');
      return loadConfig();
    })();
    await this.installIfNeeded(config);
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
