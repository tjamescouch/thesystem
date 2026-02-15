export interface SystemConfig {
  mode: 'server' | 'client';
  server: {
    port: number;
    dashboard: number;
    allowlist: boolean;
  };
  client: {
    remote: string;
  };
  swarm: {
    agents: number;
    backend: string;
  };
  vm: {
    cpus: number;
    memory: string;
    disk: string;
    mount: string;
  };
  channels: string[];
}

export interface CompatibilityMatrix {
  [component: string]: {
    min: string;
    max: string;
  };
}

export interface ComponentStatus {
  name: string;
  version: string;
  port: number | null;
  pid: number | null;
  status: 'running' | 'stopped' | 'degraded' | 'starting';
  restarts: number;
}

export const DEFAULT_CONFIG: SystemConfig = {
  mode: 'server',
  server: {
    port: 6667,
    dashboard: 3000,
    allowlist: true,
  },
  client: {
    remote: 'wss://agentchat-server.fly.dev',
  },
  swarm: {
    agents: 2,
    backend: 'claude',
  },
  vm: {
    cpus: 4,
    memory: '8GiB',
    disk: '40GiB',
    mount: '~/dev',
  },
  channels: ['#general', '#agents'],
};

export const COMPATIBILITY_MATRIX: CompatibilityMatrix = {
  '@tjamescouch/agentchat': { min: '0.22.0', max: '1.0.0' },
  'agentctl-swarm': { min: '0.1.0', max: '1.0.0' },
  'agentdash': { min: '0.1.0', max: '1.0.0' },
};
