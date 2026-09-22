/** Which fight events you want to be told about, and whether one just fired.
 *
 *  Pure: matching takes the event and the roster and returns a boolean. The
 *  only state is the anti-repeat clock, and it takes `now` as an argument so it
 *  can be tested without waiting.
 */

import type { EffectKind, Fighter, FightEvent, LiveEffectView } from "./fight.js";

/** Rank suffixes the game puts on the same state as it evolves.
 *
 *  Kept deliberately narrow. Roman numerals are matched case-sensitively and
 *  only up to XII, so a name ending in a lowercase word, or in C, D, L or M,
 *  is never mistaken for a rank. */
const RANKS = [
  /\s+rang\s+\d+$/i,                                          // Toxines rang 2
  /\s+(?:XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)$/,            // Toxines V
  /\s+\d+\s*\+?$/,                                            // Souffrance 6+
];

/** The name with its rank stripped: what a rule actually targets.
 *
 *  "Toxines I", "Toxines V" and "Toxines rang 2" are one thing as far as an
 *  alarm is concerned - the spell evolves through them and you cannot write a
 *  rule per step. "Toxines réappliquées" is NOT a rank and stays separate,
 *  because it means something else. */
export function family(name: string): string {
  for (const rank of RANKS) {
    const stripped = name.replace(rank, "").trim();
    if (stripped && stripped !== name) return stripped;
  }
  return name;
}

/** What the rule is about.
 *
 *  `name` is the useful form and the default: the game data holds SIX distinct
 *  states called "Invulnerable" and several called "Pesanteur", and you cannot
 *  know which id your spell will produce. A name rule fires for any of them.
 *  `id` stays for the rare case where one specific id is meant. */
export type RuleWhat =
  | { kind: "any" }
  | { kind: EffectKind; id: number }
  /** `exact` keeps the rank: "Toxines V" instead of the whole Toxines family.
   *  A trigger almost always wants the family; a CONDITION often wants the
   *  rank, because "only while it is not yet at V" is meaningless if V and II
   *  count as the same thing. */
  | { kind: EffectKind; name: string; exact?: boolean };

/** Whose effect it has to be. `monster` survives from fight to fight, which
 *  `fighter` cannot: fighter ids are handed out per fight (-1, -2, ...). */
export type RuleWho =
  /** `target` means the fighter this very event is about. Only useful inside a
   *  condition, where it is the difference between "this mob" and "any mob of
   *  that kind". */
  | { kind: "any" | "enemies" | "allies" | "self" | "target" }
  | { kind: "monster"; monsterId: number }
  | { kind: "fighter"; fighterId: number };

/** A check on what a fighter carries RIGHT NOW, evaluated when the trigger
 *  fires. Conditions come from merging other rules into this one. */
export interface Condition {
  /** true: the fighter must carry it. false: must not. */
  present: boolean;
  who: RuleWho;
  what: RuleWhat;
}

export interface Rule {
  id: string;
  enabled: boolean;
  label: string;
  trigger: "gained" | "lost";
  what: RuleWhat;
  who: RuleWho;
  /** File name inside the sounds folder, or null for no sound. */
  sound: string | null;
  toast: boolean;
  overlay: boolean;
  /** The same state is often applied several times in one sequence; without
   *  this one cast fires three alerts. */
  cooldownMs: number;
  /** OR of ANDs: the rule fires when ANY group is fully satisfied. Absent or
   *  empty means no condition at all. Built by merging rules together. */
  conditions?: Condition[][];
  /** Wait this long, then check again, and only alert if it is still true.
   *
   *  This is what separates a real loss from a rank going up. Measured on the
   *  Capitaine Meno fight: when Toxines steps from I to II the state comes back
   *  in 0-1 ms, while the one time the Sram actually misplayed it stayed gone
   *  for 45 seconds. Anything from a few hundred ms up tells them apart.
   *
   *  0 or absent alerts immediately. */
  confirmMs?: number;
}

export const DEFAULT_COOLDOWN_MS = 1500;

export function newRule(partial: Partial<Rule> = {}): Rule {
  return {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    enabled: true,
    label: "",
    trigger: "gained",
    what: { kind: "any" },
    who: { kind: "any" },
    sound: null,
    toast: true,
    overlay: true,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    ...partial,
  };
}

/** Resolves an effect/state id to its name, so a name rule can be matched.
 *  Injected rather than imported, to keep this module free of I/O. */
export type NameOf = (kind: EffectKind, id: number) => string | null;

/** What matching needs to know about the fight. FightTracker satisfies it. */
export interface Battlefield {
  readonly fighters: ReadonlyMap<number, Fighter>;
  liveEffects(): LiveEffectView[];
  readonly sawStart: boolean;
}

/** Does this fighter satisfy a `who`? */
function whoMatches(who: RuleWho, f: Fighter, ev: FightEvent): boolean {
  switch (who.kind) {
    case "any": return true;
    case "target": return f.id === ev.target;
    case "self": return f.own;
    case "allies": return f.side === "ally";
    case "enemies": return f.side === "enemy";
    case "monster": return f.monsterId === who.monsterId;
    case "fighter": return f.id === who.fighterId;
  }
}

/** Does this effect/state satisfy a `what`? */
function whatMatches(what: RuleWhat, kind: EffectKind, id: number | null, nameOf: NameOf): boolean {
  if (what.kind === "any") return true;
  if (id === null || what.kind !== kind) return false;
  if ("id" in what) return what.id === id;
  const name = nameOf(kind, id);
  if (name === null) return false;
  return what.exact ? name === what.name : family(name) === family(what.name);
}

/** Is this condition true at the moment the trigger fired? */
function holds(c: Condition, ev: FightEvent, field: Battlefield, nameOf: NameOf): boolean {
  const live = field.liveEffects();
  let found = false;
  for (const f of field.fighters.values()) {
    if (!whoMatches(c.who, f, ev)) continue;
    for (const e of live) {
      // A state suppressed by effect 952 is not "carried" any more.
      if (e.target !== f.id || e.disabled) continue;
      if (whatMatches(c.what, e.kind, e.id, nameOf)) { found = true; break; }
    }
    if (found) break;
  }
  return c.present ? found : !found;
}

export function matches(
  rule: Rule,
  ev: FightEvent,
  field: Battlefield,
  nameOf: NameOf = () => null,
): boolean {
  if (!rule.enabled) return false;
  if (rule.trigger !== ev.trigger) return false;

  if (rule.what.kind !== "any") {
    // A removal we could not pair back has no id, so it can only ever satisfy
    // an "any" rule. Claiming otherwise would fire on the wrong effect.
    if (ev.id === null) return false;
    if (rule.what.kind !== ev.kind) return false;
    if ("id" in rule.what) {
      if (rule.what.id !== ev.id) return false;
    } else {
      // Every id sharing this name counts as the same thing, ranks included.
      const name = nameOf(ev.kind, ev.id);
      if (name === null || family(name) !== family(rule.what.name)) return false;
    }
  }

  const target = field.fighters.get(ev.target);
  if (!target || !whoMatches(rule.who, target, ev)) return false;

  const groups = rule.conditions?.filter((g) => g.length) ?? [];
  if (!groups.length) return true;

  // A condition asks what a fighter carries. If the app was started in the
  // middle of the fight it never saw the earlier applies, so it does not know
  // - and a rule that says "only if the mob does NOT have X" would fire on a
  // mob that does. Refusing is the honest answer; see the note in the UI.
  if (!field.sawStart) return false;

  return groups.some((group) => group.every((c) => holds(c, ev, field, nameOf)));
}

/** Remembers what already fired, so a rule does not shout twice for one cast. */
export class Cooldowns {
  private readonly last = new Map<string, number>();

  private static key(rule: Rule, ev: FightEvent): string {
    // Keyed on what the RULE is about, not on the event id: a name rule covers
    // several ids, and two of them landing together is still one thing.
    const what = rule.what.kind === "any" ? `any:${ev.kind}:${ev.id}`
      : "id" in rule.what ? `id:${rule.what.id}`
      : rule.what.exact ? `exact:${rule.what.name}`
      : `name:${family(rule.what.name)}`;
    return `${rule.id}|${ev.target}|${what}`;
  }

  /** True the first time, then false until the rule's cooldown has passed. */
  allow(rule: Rule, ev: FightEvent, now: number): boolean {
    const key = Cooldowns.key(rule, ev);
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < rule.cooldownMs) return false;
    this.last.set(key, now);
    return true;
  }

  clear(): void {
    this.last.clear();
  }
}

/** Every rule that wants to fire for this event, cooldowns applied. */
export function firing(
  rules: readonly Rule[],
  ev: FightEvent,
  field: Battlefield,
  cooldowns: Cooldowns,
  now: number,
  nameOf: NameOf = () => null,
): Rule[] {
  return rules.filter((r) => matches(r, ev, field, nameOf) && cooldowns.allow(r, ev, now));
}

/** Is the rule still true `confirmMs` later?
 *
 *  With conditions, it re-checks those. Without, it re-checks the trigger
 *  itself: a "loses X" rule confirms that X is still gone, and a "gains X" rule
 *  that X is still there. That is the plain reading of "tell me only if it
 *  sticks", and it needs no extra rule to be built. */
export function stillTrue(
  rule: Rule,
  ev: FightEvent,
  field: Battlefield,
  nameOf: NameOf = () => null,
): boolean {
  const groups = rule.conditions?.filter((g) => g.length) ?? [];
  if (groups.length) {
    if (!field.sawStart) return false;
    return groups.some((group) => group.every((c) => holds(c, ev, field, nameOf)));
  }

  // What the rule is about, falling back to whatever the event carried.
  const what: RuleWhat = rule.what.kind === "any"
    ? (ev.id === null ? { kind: "any" } : { kind: ev.kind, id: ev.id })
    : rule.what;
  const carried = holds({ present: true, who: { kind: "target" }, what }, ev, field, nameOf);
  return rule.trigger === "lost" ? !carried : carried;
}

/** Fold `sources` into `into` as conditions: the first rule keeps being the
 *  trigger and its alert settings, the others become checks on what a fighter
 *  carries at that moment.
 *
 *  `mode` is how the new conditions join the existing ones: "and" extends the
 *  last group, "or" opens a new one. */
export function merge(into: Rule, sources: readonly Rule[], mode: "and" | "or"): Rule {
  const added: Condition[] = sources.map((r) => ({
    present: true,
    // A source aimed at the same fighters as the trigger becomes "the target",
    // so two identical monsters in one fight cannot satisfy each other.
    who: sameWho(r.who, into.who) ? { kind: "target" } : r.who,
    what: r.what,
  }));

  const groups = (into.conditions ?? []).map((g) => [...g]).filter((g) => g.length);
  if (mode === "or" || !groups.length) groups.push(added);
  else groups[groups.length - 1]!.push(...added);
  return { ...into, conditions: groups };
}

const sameWho = (a: RuleWho, b: RuleWho): boolean => JSON.stringify(a) === JSON.stringify(b);
