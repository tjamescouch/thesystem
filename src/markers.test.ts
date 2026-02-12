/**
 * Tests for the unified marker system.
 */

import { parse, extractMarkers, strip, textOnly, createRouter } from './markers';
import type { Marker, FnCallMarker, KVMarker, SimpleMarker, MarkerStart, MarkerEnd } from './markers';

// ---- parse() ----

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
  } catch (e: any) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
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

console.log('\n--- markers.ts tests ---\n');

// Simple markers
test('parse simple marker', () => {
  const segments = parse('Hello @@pause@@ world');
  assertEqual(segments.length, 3);
  assertEqual(segments[0], { type: 'text', content: 'Hello ' });
  assertEqual(segments[1], { type: 'marker', name: 'pause', raw: '@@pause@@' });
  assertEqual(segments[2], { type: 'text', content: ' world' });
});

test('parse closing marker', () => {
  // @@emphasis@@ is parsed as a simple marker (ambiguous without context).
  // @@/emphasis@@ is parsed as a marker_end. The consumer infers pairing.
  const segments = parse('@@emphasis@@bold@@/emphasis@@');
  assertEqual(segments.length, 3);
  assertEqual(segments[0], { type: 'marker', name: 'emphasis', raw: '@@emphasis@@' });
  assertEqual(segments[1], { type: 'text', content: 'bold' });
  assertEqual(segments[2], { type: 'marker_end', name: 'emphasis', raw: '@@/emphasis@@' });
});

// Function call markers
test('parse fn_call marker', () => {
  const segments = parse('@@memory(page=2342)@@');
  assertEqual(segments.length, 1);
  const m = segments[0] as FnCallMarker;
  assertEqual(m.type, 'fn_call');
  assertEqual(m.name, 'memory');
  assertEqual(m.args, { page: '2342' });
});

test('parse fn_call with multiple args', () => {
  const segments = parse('@@secret(name=api-key, target=header)@@');
  assertEqual(segments.length, 1);
  const m = segments[0] as FnCallMarker;
  assertEqual(m.type, 'fn_call');
  assertEqual(m.name, 'secret');
  assertEqual(m.args, { name: 'api-key', target: 'header' });
});

test('parse fn_call with no args', () => {
  const segments = parse('@@sleep()@@');
  assertEqual(segments.length, 1);
  const m = segments[0] as FnCallMarker;
  assertEqual(m.type, 'fn_call');
  assertEqual(m.name, 'sleep');
  assertEqual(m.args, {});
});

// Key-value markers
test('parse kv marker', () => {
  const segments = parse('@@fear:1,anger:0.8@@');
  assertEqual(segments.length, 1);
  const m = segments[0] as KVMarker;
  assertEqual(m.type, 'kv');
  assertEqual(m.pairs, { fear: 1, anger: 0.8 });
});

test('parse kv marker with single pair', () => {
  const segments = parse('@@confidence:0.95@@');
  assertEqual(segments.length, 1);
  const m = segments[0] as KVMarker;
  assertEqual(m.type, 'kv');
  assertEqual(m.pairs, { confidence: 0.95 });
});

// Mixed content
test('parse mixed content', () => {
  const text = 'I think @@fear:0.3@@this is important @@memory(page=42)@@ and @@pause@@ done';
  const segments = parse(text);
  assertEqual(segments.length, 7);
  assertEqual(segments[0], { type: 'text', content: 'I think ' });
  assertEqual((segments[1] as KVMarker).type, 'kv');
  assertEqual(segments[2], { type: 'text', content: 'this is important ' });
  assertEqual((segments[3] as FnCallMarker).name, 'memory');
  assertEqual(segments[4], { type: 'text', content: ' and ' });
  assertEqual((segments[5] as SimpleMarker).name, 'pause');
  assertEqual(segments[6], { type: 'text', content: ' done' });
});

// No markers
test('parse plain text', () => {
  const segments = parse('Just normal text');
  assertEqual(segments.length, 1);
  assertEqual(segments[0], { type: 'text', content: 'Just normal text' });
});

// ---- extractMarkers() ----

test('extractMarkers returns only markers', () => {
  const markers = extractMarkers('Hello @@pause@@ world @@sleep()@@');
  assertEqual(markers.length, 2);
  assertEqual(markers[0].type, 'marker');
  assertEqual(markers[1].type, 'fn_call');
});

// ---- strip() ----

test('strip removes all markers', () => {
  const clean = strip('Hello @@fear:1@@world@@pause@@ done @@memory(page=1)@@');
  assertEqual(clean, 'Hello world done');
});

test('strip on clean text is no-op', () => {
  assertEqual(strip('Just text'), 'Just text');
});

// ---- textOnly() ----

test('textOnly extracts just text', () => {
  const segments = parse('Say @@emphasis@@hello@@/emphasis@@ friend');
  const text = textOnly(segments);
  assertEqual(text, 'Say hello friend');
});

// ---- MarkerRouter ----

test('router dispatches to named handler', async () => {
  const router = createRouter();
  let called = false;
  router.on('pause', (m) => { called = true; });
  await router.route({ type: 'marker', name: 'pause', raw: '@@pause@@' });
  assert(called, 'handler should have been called');
});

test('router dispatches fn_call by name', async () => {
  const router = createRouter();
  let page = '';
  router.on('memory', (m) => {
    if (m.type === 'fn_call') page = m.args.page;
  });
  await router.route({ type: 'fn_call', name: 'memory', args: { page: '42' }, raw: '@@memory(page=42)@@' });
  assertEqual(page, '42');
});

test('router wildcard handler fires for all', async () => {
  const router = createRouter();
  const seen: string[] = [];
  router.on('*', (m) => { seen.push(m.raw); });
  await router.route({ type: 'marker', name: 'pause', raw: '@@pause@@' });
  await router.route({ type: 'fn_call', name: 'sleep', args: {}, raw: '@@sleep()@@' });
  assertEqual(seen.length, 2);
});

test('router.process returns clean text and routes markers', async () => {
  const router = createRouter();
  const markers: string[] = [];
  router.on('*', (m) => { markers.push(m.raw); });
  const clean = await router.process('Hello @@pause@@ world @@fear:0.5@@');
  assertEqual(clean, 'Hello world');
  assertEqual(markers.length, 2);
});

console.log('\n--- done ---\n');
