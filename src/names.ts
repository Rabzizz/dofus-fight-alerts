/** Turning ids into something you can read.
 *
 *  States and effects come from data/catalog.json, built by tools/build-catalog.mjs
 *  and shipped with the app, so the rule editor works with no network at all.
 *  Monsters come from the sniffer, which already holds all 5135 of them - that
 *  is what its /api/lookup is for.
 */

import { readFile } from "node:fs/promises";
import type { EffectKind } from "./fight.js";
import { family } from "./rules.js";
import { get } from "./stream.js";

/** One pickable thing in the rule editor: a NAME, plus every id that carries
 *  it. Six distinct ids are called "Invulnerable" and you cannot know which one
 *  a given spell produces, so the editor offers the name and the rule fires for
 *  all of them. */
export interface NamedGroup {
  /** The family name, ranks stripped: what the rule will target. */
  name: string;
  ids: number[];
  /** The actual names folded into it, so the editor can show what is covered. */
  variants: string[];
  /** At least one of these ids has turned up in one of your own fights. */
  seen: boolean;
}

interface Catalog {
  gameVersion: string | null;
  builtAt: string;
  state: [number, string][];
  effect: [number, string][];
}

export class Names {
  private state = new Map<number, string>();
  private effect = new Map<number, string>();
  private monster = new Map<number, string>();
  /** Ids we asked the sniffer about and got nothing back for; do not re-ask. */
  private missingMonsters = new Set<number>();
  gameVersion: string | null = null;
  builtAt = "";

  async loadCatalog(path: string): Promise<void> {
    const c = JSON.parse(await readFile(path, "utf8")) as Catalog;
    this.state = new Map(c.state);
    this.effect = new Map(c.effect);
    this.gameVersion = c.gameVersion;
    this.builtAt = c.builtAt;
  }

  /** The catalog is built per game version; say so rather than going stale quietly. */
  async catalogIsCurrent(): Promise<{ ok: boolean; current: string | null }> {
    try {
      const v = (await (await fetch("https://api.dofusdu.de/dofus3/v1/meta/version")).json()) as { version: string };
      return { ok: v.version === this.gameVersion, current: v.version };
    } catch {
      return { ok: true, current: null }; // offline is not the same as out of date
    }
  }

  /** The label for an effect or a state, or null when the game data has none.
   *  233 of the 872 effects genuinely have no name: their description in the
   *  game files is a bare "#1" placeholder. */
  of(kind: EffectKind, id: number | null): string | null {
    if (id === null) return null;
    return (kind === "state" ? this.state : this.effect).get(id) ?? null;
  }

  monsterName(id: number): string | null {
    return this.monster.get(id) ?? null;
  }

  /** Substring search for the rule editor.
   *
   *  Ids you have actually seen in a fight come first, and that is not a nicety:
   *  the game data has SIX distinct states called "Invulnerable", and picking
   *  the wrong one gives you a rule that silently never fires. What your own
   *  capture has shown is the only reliable way to tell them apart. Then
   *  shortest name first, so "Pesanteur" beats "Pesanteur de groupe". */
  search(kind: EffectKind, query: string, seen: ReadonlySet<string> = new Set(), limit = 40): NamedGroup[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const groups = new Map<string, NamedGroup>();
    for (const [id, name] of kind === "state" ? this.state : this.effect) {
      if (!name.toLowerCase().includes(q)) continue;
      const key = family(name);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { name: key, ids: [], variants: [], seen: false }));
      g.ids.push(id);
      if (!g.variants.includes(name)) g.variants.push(name);
      if (seen.has(`${kind}:${id}`)) g.seen = true;
    }
    return [...groups.values()]
      .sort((a, b) =>
        Number(b.seen) - Number(a.seen) || a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  /** Fill in any monster names we do not have yet. /api/lookup takes up to 200
   *  ids in one call, so a whole roster is a single request. */
  async fetchMonsters(baseUrl: string, ids: readonly number[]): Promise<void> {
    const want = [...new Set(ids)].filter(
      (id) => id > 0 && !this.monster.has(id) && !this.missingMonsters.has(id),
    );
    if (!want.length) return;
    for (let i = 0; i < want.length; i += 200) {
      const batch = want.slice(i, i + 200);
      const res = (await get(baseUrl, "/api/lookup", { kind: "monster", id: batch })) as {
        found?: Record<string, { name?: string }>;
      };
      for (const id of batch) {
        const name = res.found?.[String(id)]?.name;
        if (name) this.monster.set(id, name);
        else this.missingMonsters.add(id);
      }
    }
  }
}
