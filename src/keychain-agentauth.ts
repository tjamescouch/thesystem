import http from 'http';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';

const exec = promisify(execFile);

type StartOpts = {
  port: number;
  bind?: string;
};

// ---------------------------------------------------------------------------
// IP Allowlist — only these networks can reach the proxy
// ---------------------------------------------------------------------------
const ALLOWED_CIDRS = [
  '127.0.0.0/8',        // localhost (IPv4)
  '::1/128',            // localhost (IPv6)
  '::ffff:127.0.0.0/104', // IPv4-mapped localhost
  '10.0.0.0/8',         // Lima VM bridge networks
  '192.168.0.0/16',     // common private range (Lima, Podman)
  '172.16.0.0/12',      // Docker/Podman bridge default
];

function parseCIDR(cidr: string): { addr: bigint; mask: bigint; bits: number } {
  const [ip, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const isV6 = ip.includes(':');
  const bits = isV6 ? 128 : 32;
  const addr = ipToBigInt(ip, isV6);
  const mask = bits === prefix ? (isV6 ? (1n << 128n) - 1n : (1n << 32n) - 1n)
    : ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
  return { addr, mask, bits };
}

function ipToBigInt(ip: string, isV6: boolean): bigint {
  if (isV6) {
    // Expand :: and convert
    const full = net.isIPv6(ip) ? expandIPv6(ip) : ip;
    const parts = full.split(':');
    let result = 0n;
    for (const part of parts) {
      result = (result << 16n) | BigInt(parseInt(part, 16));
    }
    return result;
  }
  const parts = ip.split('.').map(Number);
  return BigInt((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) & 0xFFFFFFFFn;
}

function expandIPv6(ip: string): string {
  if (ip.includes('::')) {
    const [left, right] = ip.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - leftParts.length - rightParts.length;
    const mid = Array(missing).fill('0');
    return [...leftParts, ...mid, ...rightParts].map(p => p.padStart(4, '0')).join(':');
  }
  return ip.split(':').map(p => p.padStart(4, '0')).join(':');
}

const allowedRanges = ALLOWED_CIDRS.map(parseCIDR);

function isAllowedIP(clientIP: string): boolean {
  if (!clientIP) return false;

  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 → check both forms)
  const raw = clientIP.replace(/^::ffff:/, '');
  const isV4 = net.isIPv4(raw);
  const isV6 = net.isIPv6(clientIP);

  for (const range of allowedRanges) {
    try {
      if (isV4 && range.bits === 32) {
        const addr = ipToBigInt(raw, false);
        if ((addr & range.mask) === (range.addr & range.mask)) return true;
      } else if ((isV6 || clientIP.startsWith('::ffff:')) && range.bits === 128) {
        const addr = ipToBigInt(clientIP, true);
        if ((addr & range.mask) === (range.addr & range.mask)) return true;
      }
    } catch {
      // parse error, skip
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function timestamp(): string {
  return new Date().toISOString();
}

function extractModel(body: Buffer): string {
  try {
    const json = JSON.parse(body.toString('utf8'));
    return json.model || '-';
  } catch {
    return '-';
  }
}

function logRequest(clientIP: string, method: string, provider: string, path: string, model: string, status: number, durationMs: number) {
  const line = `[${timestamp()}] ${clientIP} ${method} /${provider}${path} model=${model} status=${status} ${durationMs}ms`;
  console.log(line);
}

function logDenied(clientIP: string, method: string, path: string) {
  console.warn(`[${timestamp()}] DENIED ${clientIP} ${method} ${path}`);
}

function logError(clientIP: string, method: string, path: string, err: string) {
  console.error(`[${timestamp()}] ERROR ${clientIP} ${method} ${path} — ${err}`);
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

interface ProviderConfig {
  /** Base URL for the upstream API */
  upstream: string;
  /** How the API key is attached to requests */
  authStyle: 'bearer' | 'x-api-key' | 'x-goog-api-key';
  /** Headers to pass through from the original request (besides content-type) */
  passthroughHeaders?: string[];
}

/**
 * All supported providers.
 * To add a new provider: add an entry here and store its key in Keychain:
 *   thesystem keys set <name> <api-key>
 */
export const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    upstream: 'https://api.anthropic.com',
    authStyle: 'x-api-key',
    passthroughHeaders: ['anthropic-version', 'anthropic-beta'],
  },
  openai: {
    upstream: 'https://api.openai.com',
    authStyle: 'bearer',
  },
  grok: {
    upstream: 'https://api.x.ai',
    authStyle: 'bearer',
  },
  xai: {
    upstream: 'https://api.x.ai',
    authStyle: 'bearer',
  },
  google: {
    upstream: 'https://generativelanguage.googleapis.com',
    authStyle: 'x-goog-api-key',
  },
  mistral: {
    upstream: 'https://api.mistral.ai',
    authStyle: 'bearer',
  },
  groq: {
    upstream: 'https://api.groq.com',
    authStyle: 'bearer',
  },
  deepseek: {
    upstream: 'https://api.deepseek.com',
    authStyle: 'bearer',
  },
};

// ---------------------------------------------------------------------------
// Keychain — tries biometric helper first, falls back to security CLI
// ---------------------------------------------------------------------------
import * as path from 'path';
import * as fs from 'fs';

const BIOMETRIC_BIN = path.join(__dirname, '..', 'dist', 'thesystem-keychain');
const hasBiometricBin = fs.existsSync(BIOMETRIC_BIN);

async function readKeyFromKeychain(provider: string): Promise<string> {
  const svc = `thesystem/${provider}`;

  // Try biometric-protected keychain first
  if (hasBiometricBin) {
    try {
      const { stdout } = await exec(BIOMETRIC_BIN, ['get', svc, provider]);
      const key = stdout.trim();
      if (key) return key;
    } catch {
      // Not stored with biometric — fall through to legacy
    }
  }

  // Fallback: plain macOS Keychain (no biometric)
  const { stdout } = await exec('security', ['find-generic-password', '-a', provider, '-s', svc, '-w']);
  const key = stdout.trim();
  if (!key) throw new Error(`Empty key for provider ${provider}`);
  return key;
}

// ---------------------------------------------------------------------------
// Generic upstream forwarder
// ---------------------------------------------------------------------------
function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  provider: string,
  config: ProviderConfig,
  upstreamPath: string,
  search: string,
  clientIP: string,
): void {
  const start = Date.now();
  const upstreamUrl = new URL(`${config.upstream}${upstreamPath}${search}`);

  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req.on('end', async () => {
    let body: Buffer = Buffer.concat(chunks);
    const model = extractModel(body);

    // Strip unsupported parameters for Anthropic API (context_management requires special access)
    if (provider === 'anthropic' && body.length > 0) {
      try {
        const json = JSON.parse(body.toString());
        if (json.context_management) {
          delete json.context_management;
          body = Buffer.from(JSON.stringify(json));
        }
      } catch { /* not JSON, pass through */ }
    }

    try {
      const apiKey = await readKeyFromKeychain(provider);

      const headers: Record<string, string> = {};
      if (config.authStyle === 'bearer') {
        headers['Authorization'] = `Bearer ${apiKey}`;
      } else if (config.authStyle === 'x-goog-api-key') {
        headers['x-goog-api-key'] = apiKey;
      } else {
        headers['x-api-key'] = apiKey;
      }

      // Forward content-type
      if (req.headers['content-type']) {
        headers['content-type'] = String(req.headers['content-type']);
      }

      // Forward provider-specific headers (e.g. anthropic-version)
      for (const h of config.passthroughHeaders ?? []) {
        const val = req.headers[h.toLowerCase()];
        if (val) headers[h] = String(val);
      }
      // Default anthropic-version when not supplied by client
      if (provider === 'anthropic' && !headers['anthropic-version']) {
        headers['anthropic-version'] = '2023-06-01';
      }

      const resp = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes((req.method || 'GET').toUpperCase()) ? undefined : body,
      });

      const fwdHeaders = Object.fromEntries(
        [...resp.headers.entries()].filter(
          ([k]) => !['content-encoding', 'transfer-encoding'].includes(k.toLowerCase())
        )
      );
      res.writeHead(resp.status, fwdHeaders);
      if (resp.body) {
        Readable.fromWeb(resp.body as any).pipe(res);
      } else {
        res.end();
      }
      logRequest(clientIP, req.method || 'GET', provider, upstreamPath, model, resp.status, Date.now() - start);
    } catch (err: any) {
      logError(clientIP, req.method || 'GET', `/${provider}${upstreamPath}`, err?.message || 'upstream fetch failed');
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end('bad gateway');
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

/**
 * Host-side agentauth proxy with logging and IP allowlist.
 * Routes /<provider>/* to the provider's upstream API, injecting the
 * API key from macOS Keychain. Supports streaming (SSE).
 *
 * Providers: {@link PROVIDERS}
 *
 * Routes:
 * - /agentauth/health -> 200 OK
 * - /agentauth/providers -> list of registered providers
 * - /agentauth/credential/<provider> -> Keychain token for git-credential-agentauth
 * - /<provider>/* -> upstream API
 *
 * Security:
 * - IP allowlist: localhost, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - All requests logged with timestamp, source IP, provider, model, status, duration
 */
export async function startAgentAuthProxy(opts: StartOpts): Promise<void> {
  const server = http.createServer(async (req, res) => {
    const clientIP = req.socket.remoteAddress || 'unknown';

    // --- IP allowlist gate ---
    if (!isAllowedIP(clientIP)) {
      logDenied(clientIP, req.method || 'GET', req.url || '/');
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // Health check (no auth needed, but still behind IP allowlist)
      if (url.pathname === '/agentauth/health') {
        console.log(`[${timestamp()}] ${clientIP} GET /agentauth/health`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', backends: Object.keys(PROVIDERS), port: opts.port }));
        return;
      }

      // List available providers
      if (url.pathname === '/agentauth/providers') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Object.keys(PROVIDERS)));
        return;
      }

      // Git credential endpoint
      const credMatch = url.pathname.match(/^\/agentauth\/credential\/(\w+)$/);
      if (credMatch) {
        const provider = credMatch[1];
        try {
          const token = await readKeyFromKeychain(provider);
          console.log(`[${timestamp()}] ${clientIP} GET /agentauth/credential/${provider} status=200`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ token }));
        } catch {
          console.warn(`[${timestamp()}] ${clientIP} GET /agentauth/credential/${provider} status=404`);
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no_credential', message: `No key for ${provider} in Keychain` }));
        }
        return;
      }

      // Match /<provider>/... against the registry
      for (const [name, config] of Object.entries(PROVIDERS)) {
        const prefix = `/${name}`;
        if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
          const upstreamPath = url.pathname.slice(prefix.length) || '/';
          proxyRequest(req, res, name, config, upstreamPath, url.search, clientIP);
          return;
        }
      }

      console.warn(`[${timestamp()}] ${clientIP} ${req.method} ${url.pathname} status=404`);
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err: any) {
      const msg = err?.message || 'internal error';
      logError(clientIP, req.method || 'GET', req.url || '/', msg);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
      }
      res.end(msg);
    }
  });

  const bindAddr = opts.bind ?? '0.0.0.0';
  server.listen(opts.port, bindAddr, () => {
    console.log(`[thesystem] agentauth proxy listening on http://${bindAddr}:${opts.port}`);
    console.log(`[thesystem] providers: ${Object.keys(PROVIDERS).join(', ')}`);
    console.log(`[thesystem] IP allowlist: ${ALLOWED_CIDRS.join(', ')}`);
  });

  // Keep process alive
  await new Promise(() => {});
}
