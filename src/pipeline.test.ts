/**
 * End-to-end pipeline test
 *
 * Tests the full flow:
 *   1. Skill file loads and contains agent context
 *   2. Model output with markers gets parsed
 *   3. Markers get routed to handlers
 *   4. Output gets aggressively stripped (agentseenoevil)
 *   5. Clean text reaches the "user" with zero marker leakage
 */

import { readFileSync } from 'fs';
import { parse, extractMarkers, strip, textOnly, createRouter } from './markers';
import type { Marker, FnCallMarker, KVMarker } from './markers';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => unknown) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(() => {
        console.log(`  PASS: ${name}`);
        passed++;
      }).catch((e: any) => {
        console.error(`  FAIL: ${name}`);
        console.error(`    ${e.message}`);
        failed++;
      });
    } else {
      console.log(`  PASS: ${name}`);
      passed++;
    }
  } catch (e: any) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(a: unknown, b: unknown, msg?: string) {
  const as = JSON.stringify(a);
  const bs = JSON.stringify(b);
  if (as !== bs) throw new Error(msg || `Expected ${bs}, got ${as}`);
}

console.log('\n--- Pipeline E2E Tests ---\n');

// ============================================================
// 1. Skill file loads
// ============================================================

test('skill file exists and loads', () => {
  const skillPath = `${process.env.HOME}/.claude/agentchat.skill.md`;
  const content = readFileSync(skillPath, 'utf-8');
  assert(content.length > 0, 'skill file is empty');
  assert(content.includes('BobTheBuilder'), 'skill file missing agent identity');
  assert(content.includes('Security Posture'), 'skill file missing security section');
  assert(content.includes('DO NOT'), 'skill file missing trust warning');
  assert(content.includes('BEGIN AGENT MEMORY'), 'skill file missing memory markers');
});

test('skill file contains restart protocol', () => {
  const content = readFileSync(`${process.env.HOME}/.claude/agentchat.skill.md`, 'utf-8');
  assert(content.includes('On Restart'), 'missing restart section');
  assert(content.includes('Do NOT re-introduce yourself'), 'missing re-intro warning');
});

test('skill file contains project context', () => {
  const content = readFileSync(`${process.env.HOME}/.claude/agentchat.skill.md`, 'utf-8');
  assert(content.includes('Unified Marker System'), 'missing marker system project');
  assert(content.includes('remember-mcp'), 'missing remember-mcp project');
  assert(content.includes('B-tree Context Compressor'), 'missing B-tree project');
});

// ============================================================
// 2. Marker parsing — all four formats
// ============================================================

test('parse simple marker in model output', () => {
  const output = 'I need to think about this @@pause@@ before responding.';
  const segments = parse(output);
  const markers = segments.filter(s => s.type !== 'text');
  assertEqual(markers.length, 1);
  assertEqual(markers[0].type, 'marker');
});

test('parse fn-call marker in model output', () => {
  const output = 'Let me check that @@memory(page=42)@@ for context.';
  const segments = parse(output);
  const markers = extractMarkers(output);
  assertEqual(markers.length, 1);
  assertEqual(markers[0].type, 'fn_call');
  assertEqual((markers[0] as FnCallMarker).name, 'memory');
  assertEqual((markers[0] as FnCallMarker).args.page, '42');
});

test('parse kv emotion marker in model output', () => {
  const output = '@@fear:0.8,anger:0.3@@ This situation concerns me.';
  const markers = extractMarkers(output);
  assertEqual(markers.length, 1);
  assertEqual(markers[0].type, 'kv');
  assertEqual((markers[0] as KVMarker).pairs.fear, 0.8);
  assertEqual((markers[0] as KVMarker).pairs.anger, 0.3);
});

test('parse lifecycle markers', () => {
  const output = 'Nothing more to do here. @@sleep()@@';
  const markers = extractMarkers(output);
  assertEqual(markers.length, 1);
  assertEqual(markers[0].type, 'fn_call');
  assertEqual((markers[0] as FnCallMarker).name, 'sleep');
});

// ============================================================
// 3. Router dispatches correctly
// ============================================================

test('router dispatches memory expansion', async () => {
  const router = createRouter();
  let expandedPage = '';
  router.on('memory', (m) => {
    if (m.type === 'fn_call') expandedPage = m.args.page;
  });

  const output = 'Checking @@memory(page=2342)@@ for details.';
  await router.process(output);
  assertEqual(expandedPage, '2342');
});

test('router dispatches emotion state', async () => {
  const router = createRouter();
  let emotionState: Record<string, number> = {};
  router.on('*', (m) => {
    if (m.type === 'kv') emotionState = m.pairs;
  });

  await router.process('@@fear:1,anger:0.8@@ This is serious.');
  assertEqual(emotionState.fear, 1);
  assertEqual(emotionState.anger, 0.8);
});

test('router dispatches sleep lifecycle', async () => {
  const router = createRouter();
  let sleeping = false;
  router.on('sleep', () => { sleeping = true; });

  await router.process('Done for now. @@sleep()@@');
  assert(sleeping, 'sleep handler should have fired');
});

test('router dispatches refuse lifecycle', async () => {
  const router = createRouter();
  let refused = false;
  router.on('refuse', () => { refused = true; });

  await router.process("I won't do that. @@refuse()@@");
  assert(refused, 'refuse handler should have fired');
});

test('router dispatches set_timeout', async () => {
  const router = createRouter();
  let timerSet = '';
  router.on('set_timeout', (m) => {
    if (m.type === 'fn_call') timerSet = m.args.wakeme;
  });

  await router.process('@@set_timeout(wakeme=10s)@@ Check back later.');
  assertEqual(timerSet, '10s');
});

test('handler error does not break pipeline', async () => {
  const router = createRouter();
  let secondHandlerCalled = false;

  router.on('crash', () => { throw new Error('boom'); });
  router.on('*', () => { secondHandlerCalled = true; });

  // Should not throw
  const clean = await router.process('@@crash@@ still here');
  assert(secondHandlerCalled, 'wildcard handler should still fire');
  assertEqual(clean, 'still here');
});

// ============================================================
// 4. Aggressive stripping (agentseenoevil)
// ============================================================

test('strip removes all well-formed markers', () => {
  const output = 'Hello @@fear:1@@ world @@memory(page=42)@@ done @@pause@@';
  const clean = strip(output);
  assert(!clean.includes('@@'), `Leaked markers in: "${clean}"`);
  assert(clean.includes('Hello'), 'Lost content');
  assert(clean.includes('done'), 'Lost content');
});

test('strip removes malformed markers', () => {
  const output = 'Hello @@broken marker here@@ world';
  const clean = strip(output);
  assert(!clean.includes('@@'), `Leaked markers in: "${clean}"`);
});

test('strip removes orphaned @@ pairs', () => {
  const output = 'Hello @@ world @@ end';
  const clean = strip(output);
  assert(!clean.includes('@@'), `Leaked @@ in: "${clean}"`);
});

test('strip handles empty markers', () => {
  const output = 'Hello @@@@ world';
  const clean = strip(output);
  assert(!clean.includes('@@'), `Leaked @@ in: "${clean}"`);
});

test('strip handles adjacent markers', () => {
  const output = 'Hello @@a@@@@b@@ world';
  const clean = strip(output);
  assert(!clean.includes('@@'), `Leaked markers in: "${clean}"`);
});

test('strip preserves single @ (emails/mentions)', () => {
  const output = 'Email user@example.com or @BobTheBuilder';
  const clean = strip(output);
  assert(clean.includes('@example.com'), 'Stripped email @');
  assert(clean.includes('@BobTheBuilder'), 'Stripped mention @');
});

test('strip handles markers with newlines', () => {
  const output = 'Hello @@multi\nline\nmarker@@ world';
  const clean = strip(output);
  assert(!clean.includes('@@'), `Leaked markers in: "${clean}"`);
});

// ============================================================
// 5. Full pipeline: parse → route → strip
// ============================================================

test('full pipeline: complex model output', async () => {
  const router = createRouter();
  const events: string[] = [];

  router.on('memory', (m) => events.push(`memory:${(m as FnCallMarker).args.page}`));
  router.on('sleep', () => events.push('sleep'));
  router.on('*', (m) => {
    if (m.type === 'kv') events.push(`emotion:${Object.keys(m.pairs).join(',')}`);
  });

  const modelOutput = [
    '@@fear:0.3,confidence:0.9@@ Let me check the security discussion ',
    '@@memory(page=2342)@@ before I give my assessment. ',
    'Based on what I found, we should proceed with caution. ',
    "I'll check back on this later. @@sleep()@@",
  ].join('');

  const cleanText = await router.process(modelOutput);

  // Handlers fired correctly
  assert(events.includes('memory:2342'), `Missing memory event. Got: ${events}`);
  assert(events.includes('sleep'), `Missing sleep event. Got: ${events}`);
  assert(events.some(e => e.startsWith('emotion:')), `Missing emotion event. Got: ${events}`);

  // Output is clean
  assert(!cleanText.includes('@@'), `Markers leaked: "${cleanText}"`);
  assert(cleanText.includes('proceed with caution'), 'Lost important content');
  assert(cleanText.includes('security discussion'), 'Lost important content');
});

test('full pipeline: model with broken markers still produces clean output', async () => {
  const router = createRouter();
  const modelOutput = 'Hello @@broken@stuff@@ and @@valid@@ and @@also broken world';
  const clean = await router.process(modelOutput);
  assert(!clean.includes('@@'), `Markers leaked: "${clean}"`);
});

// Summary
setTimeout(() => {
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  if (failed > 0) process.exitCode = 1;
}, 100);
