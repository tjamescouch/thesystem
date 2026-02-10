import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { SystemConfig, DEFAULT_CONFIG } from './types';

const CONFIG_FILENAME = 'thesystem.yaml';

function findConfigFile(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function deepMerge(base: any, override: any): any {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      typeof base[key] === 'object' && base[key] !== null &&
      typeof override[key] === 'object' && override[key] !== null &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

function resolveEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (typeof obj === 'object' && obj !== null) {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return obj;
}

export function loadConfig(cwd?: string): SystemConfig {
  const dir = cwd || process.cwd();
  const configPath = findConfigFile(dir);

  if (!configPath) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw) || {};
  const merged = deepMerge(DEFAULT_CONFIG, parsed);
  return resolveEnvVars(merged) as SystemConfig;
}

export function generateDefault(): string {
  return YAML.stringify(DEFAULT_CONFIG, { lineWidth: 0 });
}

export function writeDefaultConfig(dir: string): string {
  const configPath = path.join(dir, CONFIG_FILENAME);
  const header = `# TheSystem configuration
# Mode: "server" runs a full node (router + workers), "client" connects to a remote router
# Docs: https://github.com/tjamescouch/TheSystem#configuration
`;
  fs.writeFileSync(configPath, header + generateDefault(), 'utf-8');
  return configPath;
}
