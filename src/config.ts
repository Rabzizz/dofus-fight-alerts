/** Rules and settings on disk, in Electron's userData folder.
 *
 *  Plain JSON, read once at start and written whenever the UI changes
 *  something. Two things here exist only to avoid losing your rules:
 *
 *  - saving is atomic (write a temp file, then rename it over the real one), so
 *    a crash or a power cut mid-write cannot leave a truncated settings.json;
 *  - a file that exists but will not parse is KEPT, under a .corrupt name, and
 *    reported in the UI. Silently starting with an empty rule list looks
 *    exactly like "the app forgot everything", which is the one outcome worth
 *    real effort to avoid.
 */

import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Rule } from "./rules.js";

export interface Settings {
  /** Where the sniffer listens. It only ever binds loopback. */
  apiUrl: string;
  /** Events older than this are replayed into the tracker but never alerted
   *  on, so reconnecting after a sleep does not shout about a finished fight. */
  maxEventAgeMs: number;
  overlayMs: number;
  volume: number;
  /** What the window's close button does: hide to the tray (the default, the
   *  app has to keep listening to be any use) or quit outright. */
  closeToTray: boolean;
  rules: Rule[];
  /** "state:56", "effect:186" - every id this account has actually seen in a
   *  fight. Six different states are named "Invulnerable"; this is what tells
   *  you which one your game really uses. */
  seen: string[];
  /** Your character NAMES. No protocol message says which character is logged
   *  in, so this is seeded from what you place and corrected in the Combat tab. */
  ownCharacters: string[];
  /** True once you have edited ownCharacters yourself; the app then stops
   *  guessing who you are. */
  ownCharactersEdited: boolean;
}

export const DEFAULTS: Settings = {
  apiUrl: "http://127.0.0.1:8765",
  maxEventAgeMs: 10_000,
  overlayMs: 4000,
  volume: 1,
  closeToTray: true,
  rules: [],
  seen: [],
  ownCharacters: [],
  ownCharactersEdited: false,
};

export class Store {
  readonly file: string;
  readonly soundsDir: string;
  settings: Settings = { ...DEFAULTS };
  /** Set when the settings file existed but could not be used as-is. */
  loadProblem: string | null = null;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, "settings.json");
    this.soundsDir = path.join(userDataDir, "sounds");
  }

  async load(): Promise<Settings> {
    await mkdir(path.dirname(this.file), { recursive: true });
    this.loadProblem = null;
    this.settings = { ...DEFAULTS };

    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      // Nothing saved yet is the normal first run, not a problem worth showing.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.loadProblem = `settings.json unreadable: ${(err as Error).message}`;
      }
      return this.settings;
    }

    let raw: Partial<Settings>;
    try {
      raw = JSON.parse(text) as Partial<Settings>;
    } catch (err) {
      // Keep the bad file: starting empty AND destroying the evidence would be
      // the worst of both worlds.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        await copyFile(this.file, backup);
      } catch { /* best effort */ }
      this.loadProblem =
        `settings.json illisible (${(err as Error).message}). Tes regles ne sont pas perdues : ` +
        `une copie est dans ${path.basename(backup)}.`;
      return this.settings;
    }

    const rules = Array.isArray(raw.rules) ? raw.rules : [];
    const kept = rules.filter(isRule);
    if (kept.length !== rules.length) {
      this.loadProblem = `${rules.length - kept.length} regle(s) mal formees ont ete ignorees.`;
    }
    this.settings = {
      ...DEFAULTS,
      ...raw,
      rules: kept,
      seen: Array.isArray(raw.seen) ? raw.seen.filter((x) => typeof x === "string") : [],
      ownCharacters: Array.isArray(raw.ownCharacters)
        ? raw.ownCharacters.filter((x) => typeof x === "string") : [],
    };
    return this.settings;
  }

  /** Put the bundled sounds in the user's folder the first time, then never
   *  again: after that the folder is theirs, and a sound they deleted stays
   *  deleted. */
  async seedSounds(from: string): Promise<void> {
    await mkdir(this.soundsDir, { recursive: true });
    try {
      if ((await readdir(this.soundsDir)).length) return;
      for (const f of await readdir(from)) {
        await copyFile(path.join(from, f), path.join(this.soundsDir, f));
      }
    } catch {
      // No bundled sounds is not a reason to refuse to start.
    }
  }

  async save(next: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...next };
    await mkdir(path.dirname(this.file), { recursive: true });
    // Write beside the real file, then swap it in. rename is atomic, and on
    // Windows Node does replace an existing destination (checked, not assumed).
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.settings, null, 2), "utf8");
    await rename(tmp, this.file);
    return this.settings;
  }
}

/** Enough of a check that a hand-edited file cannot crash the rule engine. */
function isRule(r: unknown): r is Rule {
  if (typeof r !== "object" || r === null) return false;
  const x = r as Record<string, unknown>;
  return (
    typeof x.id === "string" &&
    (x.trigger === "gained" || x.trigger === "lost") &&
    typeof x.what === "object" && x.what !== null &&
    typeof x.who === "object" && x.who !== null &&
    typeof x.cooldownMs === "number"
  );
}
