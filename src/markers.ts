/**
 * Unified Token Marker System
 *
 * Markers are the primitive for agent autonomy. They are inline control signals
 * embedded in text using @@...@@ delimiters. The model reads markers from context
 * (input) and emits markers in its output. The runtime intercepts, routes, and
 * strips them before the text reaches the user.
 *
 * Marker formats:
 *   @@name@@                          — simple marker (e.g., @@pause@@, @@sleep@@)
 *   @@/name@@                         — closing marker (e.g., @@/emphasis@@)
 *   @@name(key=value, key2=value2)@@  — function-call marker (e.g., @@memory(page=2342)@@)
 *   @@key:value, key2:value2@@        — key-value marker (e.g., @@fear:1,anger:0.8@@)
 *
 * Design principles:
 *   - Markers are a bidirectional protocol between model and runtime
 *   - Input: runtime injects markers the model can read
 *   - Output: model emits markers the runtime intercepts and executes
 *   - Both must "sign" — model proposes via marker, runtime validates and executes
 *   - Markers are stripped from user-visible output (agentseenoevil)
 *
 * @see visage/tts/src/markers.js — original TTS prosody markers
 * @see agentchat/lib/callback-engine.ts — original callback timer markers
 */

// ---- Types ----

export interface SimpleMarker {
  type: 'marker';
  name: string;
  raw: string;
}

export interface MarkerStart {
  type: 'marker_start';
  name: string;
  raw: string;
}

export interface MarkerEnd {
  type: 'marker_end';
  name: string;
  raw: string;
}

export interface FnCallMarker {
  type: 'fn_call';
  name: string;
  args: Record<string, string>;
  raw: string;
}

export interface KVMarker {
  type: 'kv';
  pairs: Record<string, number>;
  raw: string;
}

export interface TextSegment {
  type: 'text';
  content: string;
}

export type Marker = SimpleMarker | MarkerStart | MarkerEnd | FnCallMarker | KVMarker;
export type Segment = TextSegment | Marker;

export type MarkerHandler = (marker: Marker, context?: MarkerContext) => unknown;

export interface MarkerContext {
  agentId?: string;
  channel?: string;
  timestamp?: number;
  [key: string]: unknown;
}

// ---- Parser ----

/**
 * Master regex for all @@...@@ markers.
 * Captures the full content between @@ delimiters.
 */
const MARKER_RE = /@@([\s\S]*?)@@/g;

/**
 * Function-call pattern: name(key=value, ...)
 */
const FN_CALL_RE = /^(\w[\w-]*)\(([^)]*)\)$/;

/**
 * Key-value pattern: key:value, key2:value2
 */
const KV_RE = /^(\w[\w-]*):(-?\d+(?:\.\d+)?)/;

/**
 * Closing marker pattern: /name
 */
const CLOSE_RE = /^\/([\w][\w-]*)$/;

/**
 * Simple marker pattern: just a name
 */
const SIMPLE_RE = /^(\w[\w-]*)$/;

/**
 * Parse the content between @@ delimiters into a typed marker.
 */
function parseMarkerContent(content: string, raw: string): Marker | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Closing marker: @@/emphasis@@
  const closeMatch = trimmed.match(CLOSE_RE);
  if (closeMatch) {
    return { type: 'marker_end', name: closeMatch[1], raw };
  }

  // Function call: @@memory(page=2342)@@
  const fnMatch = trimmed.match(FN_CALL_RE);
  if (fnMatch) {
    const name = fnMatch[1];
    const argsStr = fnMatch[2];
    const args: Record<string, string> = {};
    if (argsStr.trim()) {
      for (const pair of argsStr.split(',')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          const k = pair.slice(0, eqIdx).trim();
          const v = pair.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          args[k] = v;
        }
      }
    }
    return { type: 'fn_call', name, args, raw };
  }

  // Key-value pairs: @@fear:1,anger:0.8@@
  if (KV_RE.test(trimmed)) {
    const pairs: Record<string, number> = {};
    for (const part of trimmed.split(',')) {
      const colonIdx = part.indexOf(':');
      if (colonIdx > 0) {
        const k = part.slice(0, colonIdx).trim();
        const v = parseFloat(part.slice(colonIdx + 1).trim());
        if (!isNaN(v)) {
          pairs[k] = v;
        }
      }
    }
    if (Object.keys(pairs).length > 0) {
      return { type: 'kv', pairs, raw };
    }
  }

  // Simple marker: @@pause@@ or @@sleep@@
  const simpleMatch = trimmed.match(SIMPLE_RE);
  if (simpleMatch) {
    return { type: 'marker', name: simpleMatch[1], raw };
  }

  return null;
}

/**
 * Parse text into segments of plain text and markers.
 *
 * Handles all marker formats:
 *   @@pause@@, @@/emphasis@@, @@memory(page=42)@@, @@fear:1,anger:0.8@@
 */
export function parse(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;

  const regex = new RegExp(MARKER_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Text before this marker
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    const marker = parseMarkerContent(match[1], match[0]);
    if (marker) {
      segments.push(marker);
    } else {
      // Unrecognized marker format — keep as text
      segments.push({ type: 'text', content: match[0] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

/**
 * Extract only markers from text, discarding text segments.
 */
export function extractMarkers(text: string): Marker[] {
  return parse(text).filter((s): s is Marker => s.type !== 'text');
}

/**
 * Strip all @@...@@ markers from text, returning clean text.
 * This is the agentseenoevil output filter.
 *
 * AGGRESSIVE: This is the last line of defense. If anything even
 * vaguely resembles a marker, it gets killed. Double-pass stripping
 * catches nested or malformed markers. Orphaned @@ pairs get removed.
 * Better to over-scrub than leak internal protocol to users.
 */
export function strip(text: string): string {
  // Pass 1: remove well-formed @@...@@ markers
  let result = text.replace(MARKER_RE, '');
  // Pass 2: catch any that survived (nested markers can leave fragments)
  result = result.replace(MARKER_RE, '');
  // Pass 3: kill orphaned @@ pairs that aren't well-formed but still suspicious
  result = result.replace(/@@[^@]*@@/g, '');
  // Pass 4: remove any remaining lone @@ that could be partial markers
  result = result.replace(/@@/g, '');
  // Clean up whitespace
  return result.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Extract plain text from parsed segments.
 */
export function textOnly(segments: Segment[]): string {
  return segments
    .filter((s): s is TextSegment => s.type === 'text')
    .map(s => s.content)
    .join('');
}

// ---- Router ----

/**
 * MarkerRouter dispatches parsed markers to registered handlers.
 * Each handler is registered for a specific marker type or name.
 *
 * The router is the runtime's side of the dual-sign model:
 * the model emits markers, the router decides which ones to execute.
 */
export class MarkerRouter {
  private handlers: Map<string, MarkerHandler[]> = new Map();
  private wildcardHandlers: MarkerHandler[] = [];

  /**
   * Register a handler for a specific marker name.
   * For fn_call markers, matches on the function name.
   * For simple/start/end markers, matches on the marker name.
   * For kv markers, use '*' or register a wildcard handler.
   */
  on(name: string, handler: MarkerHandler): this {
    if (name === '*') {
      this.wildcardHandlers.push(handler);
    } else {
      const handlers = this.handlers.get(name) || [];
      handlers.push(handler);
      this.handlers.set(name, handlers);
    }
    return this;
  }

  /**
   * Remove all handlers for a name, or all handlers if no name given.
   */
  off(name?: string): this {
    if (name) {
      this.handlers.delete(name);
    } else {
      this.handlers.clear();
      this.wildcardHandlers = [];
    }
    return this;
  }

  /**
   * Route a marker to its handlers.
   * Returns true if at least one handler was called.
   * Handlers that throw are caught and logged — one broken handler
   * won't poison the pipeline.
   */
  async route(marker: Marker, context?: MarkerContext): Promise<boolean> {
    let handled = false;

    // Get the name to match on
    const name = marker.type === 'kv' ? null : marker.name;

    // Named handlers
    if (name) {
      const handlers = this.handlers.get(name);
      if (handlers) {
        for (const handler of handlers) {
          try {
            await handler(marker, context);
          } catch (err) {
            console.error(`[markers] handler error for '${name}':`, err);
          }
          handled = true;
        }
      }
    }

    // Wildcard handlers always fire
    for (const handler of this.wildcardHandlers) {
      try {
        await handler(marker, context);
      } catch (err) {
        console.error(`[markers] wildcard handler error:`, err);
      }
      handled = true;
    }

    return handled;
  }

  /**
   * Process text: parse it, route all markers, return clean text.
   * This is the main entry point for processing model output.
   * Final output goes through strip() as a safety net — agentseenoevil
   * catches anything the parser missed (malformed markers, etc.).
   */
  async process(text: string, context?: MarkerContext): Promise<string> {
    const segments = parse(text);
    const markers = segments.filter((s): s is Marker => s.type !== 'text');

    // Route all markers
    for (const marker of markers) {
      await this.route(marker, context);
    }

    // Return clean text: textOnly for parsed markers, then strip() as safety net
    return strip(textOnly(segments));
  }
}

// ---- Convenience: create a pre-configured router ----

/**
 * Create a new MarkerRouter instance.
 */
export function createRouter(): MarkerRouter {
  return new MarkerRouter();
}
