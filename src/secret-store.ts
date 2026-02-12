import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const exec = promisify(execFile);

/**
 * Secret store abstraction for secure credential management.
 *
 * Backends:
 * - macOS Keychain (via `security` CLI)
 * - Linux libsecret (via `secret-tool` CLI)
 * - AES-256-CBC file fallback (for headless/CI environments)
 *
 * Auto-detects platform at initialization.
 */

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SERVICE_NAME = 'thesystem';

// --- macOS Keychain backend ---

class KeychainStore implements SecretStore {
  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await exec('security', [
        'find-generic-password',
        '-s', SERVICE_NAME,
        '-a', key,
        '-w',
      ], { timeout: 5000 });
      return stdout.trim() || null;
    } catch {
      return null; // Not found or keychain locked
    }
  }

  async set(key: string, value: string): Promise<void> {
    // -U flag updates if exists, adds if not
    await exec('security', [
      'add-generic-password',
      '-s', SERVICE_NAME,
      '-a', key,
      '-w', value,
      '-U',
    ], { timeout: 5000 });
  }

  async delete(key: string): Promise<void> {
    try {
      await exec('security', [
        'delete-generic-password',
        '-s', SERVICE_NAME,
        '-a', key,
      ], { timeout: 5000 });
    } catch {
      // Ignore if not found
    }
  }
}

// --- Linux libsecret backend ---

class LibsecretStore implements SecretStore {
  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await exec('secret-tool', [
        'lookup', 'service', SERVICE_NAME, 'key', key,
      ], { timeout: 5000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    // secret-tool reads the secret from stdin
    const child = require('child_process').spawn('secret-tool', [
      'store', '--label', `${SERVICE_NAME}:${key}`,
      'service', SERVICE_NAME, 'key', key,
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });

    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`secret-tool store exited with code ${code}`));
      });
      child.stdin.write(value);
      child.stdin.end();
    });
  }

  async delete(key: string): Promise<void> {
    try {
      await exec('secret-tool', [
        'clear', 'service', SERVICE_NAME, 'key', key,
      ], { timeout: 5000 });
    } catch {
      // Ignore if not found
    }
  }
}

// --- AES-256-CBC file fallback ---

class AESFileStore implements SecretStore {
  private dir: string;

  constructor() {
    this.dir = path.join(
      process.env.HOME || process.env.USERPROFILE || '/tmp',
      '.thesystem', 'secrets'
    );
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
  }

  private filePath(key: string): string {
    // Sanitize key to filesystem-safe name
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.enc`);
  }

  private deriveKey(passphrase: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
  }

  async get(key: string): Promise<string | null> {
    const fp = this.filePath(key);
    if (!fs.existsSync(fp)) return null;

    // For non-interactive use, check env for passphrase
    const passphrase = process.env.THESYSTEM_SECRET_PASSPHRASE;
    if (!passphrase) {
      console.error(`[thesystem] Secret '${key}' is encrypted. Set THESYSTEM_SECRET_PASSPHRASE to decrypt.`);
      return null;
    }

    try {
      const data = fs.readFileSync(fp);
      const salt = data.subarray(0, 16);
      const iv = data.subarray(16, 32);
      const encrypted = data.subarray(32);
      const derivedKey = this.deriveKey(passphrase, salt);
      const decipher = crypto.createDecipheriv('aes-256-cbc', derivedKey, iv);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString('utf-8');
    } catch (err: any) {
      console.error(`[thesystem] Failed to decrypt secret '${key}': ${err.message}`);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const passphrase = process.env.THESYSTEM_SECRET_PASSPHRASE;
    if (!passphrase) {
      throw new Error('THESYSTEM_SECRET_PASSPHRASE required for AES file store. Set it in your environment.');
    }

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const derivedKey = this.deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-cbc', derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);

    // Format: salt(16) + iv(16) + ciphertext
    const output = Buffer.concat([salt, iv, encrypted]);
    fs.writeFileSync(this.filePath(key), output, { mode: 0o600 });
  }

  async delete(key: string): Promise<void> {
    const fp = this.filePath(key);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  }
}

// --- Factory ---

async function detectBackend(): Promise<'keychain' | 'libsecret' | 'aes-file'> {
  // Check for macOS Keychain
  if (process.platform === 'darwin') {
    try {
      await exec('which', ['security'], { timeout: 2000 });
      return 'keychain';
    } catch { /* fall through */ }
  }

  // Check for Linux secret-tool (libsecret/gnome-keyring)
  if (process.platform === 'linux') {
    try {
      await exec('which', ['secret-tool'], { timeout: 2000 });
      return 'libsecret';
    } catch { /* fall through */ }
  }

  // Fallback to AES file store
  return 'aes-file';
}

let _instance: SecretStore | null = null;

export async function createSecretStore(): Promise<SecretStore> {
  if (_instance) return _instance;

  const backend = await detectBackend();

  switch (backend) {
    case 'keychain':
      console.log('[thesystem] Using macOS Keychain for secret storage.');
      _instance = new KeychainStore();
      break;
    case 'libsecret':
      console.log('[thesystem] Using libsecret for secret storage.');
      _instance = new LibsecretStore();
      break;
    case 'aes-file':
      console.log('[thesystem] Using AES-256-CBC file store for secrets (headless fallback).');
      _instance = new AESFileStore();
      break;
  }

  return _instance;
}
