/** The live feed from the local sniffer API.
 *
 *  This is a small reimplementation of the sniffer's own TypeScript client, and
 *  not a case of not-invented-here: that client calls JSON.parse on each frame,
 *  which silently destroys every negative fighter id (see src/json.ts). We need
 *  control of the parse, so we need our own reader. It is ~60 lines.
 *
 *  EventSource is not used: it cannot be given headers, it reconnects on its own
 *  terms, and we want to resume from an exact message id.
 */

import { parseKeepingBigInts } from "./json.js";

export interface SnifferMessage {
  id: number;
  ts: string;
  dir: "c2s" | "s2c";
  kind: string;
  /** Stable across game updates. null when the type is not identified. */
  name: string | null;
  key: string | null;
  /** Values by field name. Big integers arrive as decimal strings. */
  fields?: Record<string, unknown>;
  /** The raw tree and the paths `fields` was projected from. Build-specific, so
   *  never branch on them - but needed to read a repeated group entry by entry
   *  rather than as parallel arrays. See entries() in json.ts. */
  decoded?: unknown;
  field_paths?: Record<string, string>;
  /** How long ago this was captured, in ms. Our own, not from the API. */
  ageMs: number;
}

export interface StreamHandlers {
  onMessage: (m: SnifferMessage) => void;
  onStatus: (connected: boolean, detail?: string) => void;
}

/** Split an SSE buffer into whole frames, keeping the unfinished tail. */
export function parseFrames(buffer: string): { data: string[]; rest: string } {
  const frames = buffer.split(/\r?\n\r?\n/);
  const rest = frames.pop() ?? "";
  const data: string[] = [];
  for (const frame of frames) {
    const lines: string[] = [];
    let event = "message";
    for (const line of frame.split(/\r?\n/)) {
      if (line === "" || line.startsWith(":")) continue; // a comment is a keep-alive
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") lines.push(value);
    }
    if (event === "message" && lines.length) data.push(lines.join("\n"));
  }
  return { data, rest };
}

/** Follow the capture. Returns a function that stops it. */
export function follow(baseUrl: string, h: StreamHandlers): () => void {
  const controller = new AbortController();
  let lastId: number | undefined;

  (async () => {
    while (!controller.signal.aborted) {
      try {
        const url = new URL(baseUrl.replace(/\/$/, "") + "/api/stream");
        if (lastId !== undefined) url.searchParams.set("after_id", String(lastId));
        const res = await fetch(url, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream -> ${res.status}`);
        h.onStatus(true);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;
          buffer += decoder.decode(value, { stream: true });
          const { data, rest } = parseFrames(buffer);
          buffer = rest;
          for (const d of data) {
            let m: SnifferMessage;
            try {
              m = parseKeepingBigInts(d) as SnifferMessage;
            } catch {
              continue; // a truncated frame is not worth killing the stream for
            }
            lastId = m.id;
            m.ageMs = Date.now() - Date.parse(m.ts);
            h.onMessage(m);
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        h.onStatus(false, err instanceof Error ? err.message : String(err));
      }
      if (controller.signal.aborted) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  return () => controller.abort();
}

/** One-shot GET against the API, with the same big-integer-safe parse. */
export async function get(baseUrl: string, path: string, params: Record<string, unknown> = {}) {
  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const one of v) url.searchParams.append(k, String(one));
    else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return parseKeepingBigInts(await res.text());
}
