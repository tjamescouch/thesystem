import http from 'http';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

type StartOpts = {
  port: number;
  bind?: string;
};

async function readKeyFromKeychain(provider: string): Promise<string> {
  const svc = `thesystem/${provider}`;
  const { stdout } = await exec('security', ['find-generic-password', '-a', provider, '-s', svc, '-w']);
  const key = stdout.trim();
  if (!key) throw new Error(`Empty key for provider ${provider}`);
  return key;
}

/**
 * Minimal host-side agentauth proxy.
 * - /agentauth/health -> 200 OK
 * - /anthropic/* -> forwards to https://api.anthropic.com/* with x-api-key from Keychain
 * - /openai/* -> forwards to https://api.openai.com/* with Authorization Bearer from Keychain
 *
 * SECURITY NOTE:
 * Binds to all interfaces (0.0.0.0) so Lima VM containers can reach it via
 * host.lima.internal. Restrict external access via host firewall.
 */
export async function startAgentAuthProxy(opts: StartOpts): Promise<void> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (url.pathname === '/agentauth/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }

      // Anthropic proxy
      if (url.pathname === '/anthropic' || url.pathname.startsWith('/anthropic/')) {
        const upstreamPath = url.pathname.replace(/^\/anthropic/, '') || '/';
        const upstreamUrl = new URL(`https://api.anthropic.com${upstreamPath}${url.search}`);

        const apiKey = await readKeyFromKeychain('anthropic');

        // Read request body
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on('end', async () => {
          const body = Buffer.concat(chunks);

          const headers: Record<string, string> = {
            'x-api-key': apiKey,
            'anthropic-version': String(req.headers['anthropic-version'] || '2023-06-01'),
          };
          if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);

          // Pipe response stream — supports SSE/streaming APIs
          const resp = await fetch(upstreamUrl, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes((req.method || 'GET').toUpperCase()) ? undefined : body,
          });

          // fetch() transparently decompresses content-encoding (gzip/br/deflate).
          // Forwarding content-encoding would cause the client to double-decompress.
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
        });
        return;
      }

      // OpenAI proxy
      if (url.pathname === '/openai' || url.pathname.startsWith('/openai/')) {
        const upstreamPath = url.pathname.replace(/^\/openai/, '') || '/';
        const upstreamUrl = new URL(`https://api.openai.com${upstreamPath}${url.search}`);

        const apiKey = await readKeyFromKeychain('openai');

        // Read request body
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on('end', async () => {
          const body = Buffer.concat(chunks);

          const headers: Record<string, string> = {
            'Authorization': `Bearer ${apiKey}`,
          };
          if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);

          // Pipe response stream — supports SSE/streaming APIs
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
        });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err: any) {
      const msg = err?.message || 'internal error';
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(msg);
    }
  });

  const bindAddr = opts.bind ?? '0.0.0.0';
  server.listen(opts.port, bindAddr, () => {
    console.log(`[thesystem] agentauth proxy listening on http://${bindAddr}:${opts.port} (LAN + VM accessible)`);
  });

  // Keep process alive
  await new Promise(() => {});
}
