import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeDefaultConfig } from './config-loader';

const exec = promisify(execFile);

/**
 * Interactive init — guides user through first-time setup.
 *
 * Steps:
 * 1. Write thesystem.yaml with defaults
 * 2. Check prerequisites (Node, Lima)
 * 3. Prompt for API keys and store in macOS Keychain
 */

interface InitOptions {
  cwd: string;
  nonInteractive?: boolean;
}

function checkPrerequisite(name: string): Promise<boolean> {
  return exec('which', [name])
    .then(() => true)
    .catch(() => false);
}

function promptSecret(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function keychainHasKey(provider: string): Promise<boolean> {
  try {
    const svc = `thesystem/${provider}`;
    const { stdout } = await exec('security', ['find-generic-password', '-a', provider, '-s', svc, '-w']);
    return !!stdout.trim();
  } catch {
    return false;
  }
}

async function keychainSetKey(provider: string, key: string): Promise<void> {
  const svc = `thesystem/${provider}`;
  await exec('security', ['add-generic-password', '-a', provider, '-s', svc, '-w', key, '-U']);
}

export async function runInit(options: InitOptions): Promise<void> {
  const { cwd, nonInteractive } = options;

  console.log('[thesystem] Initializing...\n');

  // Step 1: Write config file
  const configPath = path.join(cwd, 'thesystem.yaml');
  if (fs.existsSync(configPath)) {
    console.log('  thesystem.yaml ... already exists (keeping existing)');
  } else {
    writeDefaultConfig(cwd);
    console.log('  thesystem.yaml ... created with defaults');
  }

  // Step 2: Check prerequisites
  console.log('\n[thesystem] Checking prerequisites...\n');

  const prereqs: { name: string; install: string }[] = [
    { name: 'limactl', install: 'brew install lima' },
    { name: 'node', install: 'brew install node' },
  ];

  let allGood = true;
  for (const p of prereqs) {
    const found = await checkPrerequisite(p.name);
    if (found) {
      console.log(`  ✓ ${p.name}`);
    } else {
      console.log(`  ✗ ${p.name} — install with: ${p.install}`);
      allGood = false;
    }
  }

  // Step 3: API keys → macOS Keychain
  console.log('\n[thesystem] API keys (stored in macOS Keychain)...\n');

  const keyChecks: { name: string; keychainName: string; hint: string }[] = [
    { name: 'Anthropic',       keychainName: 'anthropic', hint: 'sk-ant-...' },
    { name: 'OpenAI',          keychainName: 'openai',    hint: 'sk-...' },
    { name: 'xAI / Grok',     keychainName: 'grok',      hint: 'xai-...' },
    { name: 'Google / Gemini', keychainName: 'google',    hint: 'AI...' },
    { name: 'Mistral',         keychainName: 'mistral',   hint: '' },
    { name: 'Groq',            keychainName: 'groq',      hint: 'gsk_...' },
    { name: 'DeepSeek',        keychainName: 'deepseek',  hint: '' },
  ];

  let keysStored = 0;

  for (const key of keyChecks) {
    const inKeychain = await keychainHasKey(key.keychainName);

    if (inKeychain) {
      console.log(`  ✓ ${key.name} — in Keychain`);
    } else if (nonInteractive) {
      console.log(`  - ${key.name} — not set (run: thesystem keys set ${key.keychainName} <key>)`);
    } else {
      const hintStr = key.hint ? ` (${key.hint})` : '';
      console.log(`  ? ${key.name} — not found`);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const value = await promptSecret(rl, `    Enter ${key.name} API key${hintStr} (or press Enter to skip): `);
      rl.close();

      if (value) {
        await keychainSetKey(key.keychainName, value);
        keysStored++;
        console.log(`    ✓ Stored in macOS Keychain`);
      } else {
        console.log(`    → Skipped (add later: thesystem keys set ${key.keychainName} <key>)`);
      }
    }
  }

  // Step 4: Summary
  console.log('\n[thesystem] Init complete.\n');

  if (!allGood) {
    console.log('  ⚠ Some prerequisites are missing. Install them, then run:');
    console.log('    thesystem doctor\n');
  }

  if (keysStored > 0) {
    console.log(`  ✓ ${keysStored} key(s) stored in macOS Keychain`);
  }

  console.log('\n  Next steps:');
  console.log('    1. Edit thesystem.yaml if needed');
  console.log('    2. Start everything: thesystem start');
  console.log('');
}
