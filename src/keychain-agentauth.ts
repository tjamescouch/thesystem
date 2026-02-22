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
// Keychain
// ---------------------------------------------------------------------------
async function readKeyFromKeychain(provider: string): Promise<string> {
  const svc = `thesystem/${provider}`;
  const { stdout } = await exec('security', ['find-generic-password', '-a', provider, '-s', svc, '-w']);
  const key = stdout.trim();
  if (!key) throw new Error(`Empty key for provider ${provider}`);
  return key;
}

// ---------------------------------------------------------------------------
// Generic upstream forwarder
// ---------------------------------------------------------------------------
type ProxyRoute = {
  provider: string;
  upstreamBase: string;
  authHeader: (apiKey: string) => Record<string, string>;
  extraHeaders?: (req: http.IncomingMessage) => Record<string, string>;
};

const ROUTES: ProxyRoute[] = [
  {
    provider: 'anthropic',
    upstreamBase: 'https://api.anthropic.com',
    authHeader: (k) => ({ 'x-api-key': k }),
    extraHeaders: (req) => ({
      'anthropic-version': String(req.headers['anthropic-version'] || '2023-06-01'),
    }),
  },
  {
    provider: 'openai',
    upstreamBase: 'https://api.openai.com',
    authHeader: (k) => ({ 'Authorization': `Bearer ${k}` }),
  },
  {
    provider: 'xai',
    upstreamBase: 'https://api.x.ai',
    authHeader: (k) => ({ 'Authorization': `Bearer ${k}` }),
  },
  {
    provider: 'google',
    upstreamBase: 'https://generativelanguage.googleapis.com',
    authHeader: (k) => ({ 'x-goog-api-key': k }),
  },
];

async function proxyRequest(
  route: ProxyRoute,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  clientIP: string,
) {
  const start = Date.now();
  const prefix = `/${route.provider}`;
  const upstreamPath = url.pathname.replace(new RegExp(`^${prefix}`), '') || '/';
  const upstreamUrl = new URL(`${route.upstreamBase}${upstreamPath}${url.search}`);

  const apiKey = await readKeyFromKeychain(route.provider);

  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const model = extractModel(body);

    const headers: Record<string, string> = {
      ...route.authHeader(apiKey),
      ...(route.extraHeaders?.(req) ?? {}),
    };
    if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);

    try {
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
      logRequest(clientIP, req.method || 'GET', route.provider, upstreamPath, model, resp.status, Date.now() - start);
    } catch (err: any) {
      logError(clientIP, req.method || 'GET', url.pathname, err?.message || 'upstream fetch failed');
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
    }
  });
}

/**
 * Host-side agentauth proxy with logging and IP allowlist.
 *
 * Routes:
 * - /agentauth/health -> 200 OK
 * - /agentauth/credential/<provider> -> Keychain token for git-credential-agentauth
 * - /anthropic/* -> https://api.anthropic.com/*
 * - /openai/*    -> https://api.openai.com/*
 * - /xai/*       -> https://api.x.ai/*
 * - /google/*    -> https://generativelanguage.googleapis.com/*
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
        res.end(JSON.stringify({ status: 'ok', backends: ['anthropic', 'openai', 'xai', 'google', 'github'], port: opts.port }));
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

      // Provider proxy routes
      for (const route of ROUTES) {
        const prefix = `/${route.provider}`;
        if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
          await proxyRequest(route, req, res, url, clientIP);
          return;
        }
      }

      console.warn(`[${timestamp()}] ${clientIP} ${req.method} ${url.pathname} status=404`);
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err: any) {
      const msg = err?.message || 'internal error';
      logError(clientIP, req.method || 'GET', req.url || '/', msg);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(msg);
    }
  });

  const bindAddr = opts.bind ?? '0.0.0.0';
  server.listen(opts.port, bindAddr, () => {
    console.log(`[thesystem] agentauth proxy listening on http://${bindAddr}:${opts.port}`);
    console.log(`[thesystem] IP allowlist: ${ALLOWED_CIDRS.join(', ')}`);
  });

  // Keep process alive
  await new Promise(() => {});
}
