import test from "node:test";
import assert from "node:assert/strict";
import { FightTracker } from "../src/fight.js";
import type { SnifferMessage } from "../src/stream.js";
import { Cooldowns, family, firing, merge, newRule, stillTrue } from "../src/rules.js";

/** Fighter ids as the API actually sends them: unsigned, so -1 is 2^64-1.
 *  Strings, because that is what parseKeepingBigInts produces. */
const unsigned = (n: number) => String(2n ** 64n + BigInt(n));
const MOB = unsigned(-1);
const SUMMON = unsigned(-2);
const ME = 5000000001;
const MATE = 5000000002;

let seq = 0;
function msg(name: string, fields: Record<string, unknown>, dir: "c2s" | "s2c" = "s2c"): SnifferMessage {
  return { id: ++seq, ts: new Date().toISOString(), dir, kind: "EVT", name, key: null, fields, ageMs: 0 };
}

/** A fight with one mob, me and a team mate.
 *
 *  Sides come from fight_placement_cells, the game's own split of the start
 *  cells. The `team` values below are deliberately inconsistent with the sides
 *  (the two allies get 1 and 7, the mob gets 3) because that is exactly what a
 *  real capture contains: that field is the facing, not the team. */
function opened(): FightTracker {
  const t = new FightTracker();
  t.handle(msg("fight_started", { fight_id: 99 }));
  t.handle(msg("fight_placement_cells", { attacker_cells: [200, 201, 202], defender_cells: [100, 101, 102] }));
  t.handle(msg("fighter_info", { fighter_id: MOB, cell: 100, monster_id: 2386, monster_level: 88, monster_grade: 5 }));
  t.handle(msg("fighter_info", { fighter_id: ME, cell: 200, player_name: "Moi" }));
  t.handle(msg("fighter_info", { fighter_id: MATE, cell: 201, player_name: "Copain" }));
  t.handle(msg("fight_placement_positions", { fighter_id: [MOB, ME, MATE], team: [3, 1, 7], cell: [100, 200, 201] }));
  t.handle(msg("fight_placement_position_request", { fighter_id: ME, cell: 200 }, "c2s"));
  t.handle(msg("fight_turn_start", { fighter_id: ME, round: 3 }));
  return t;
}

const applied = (target: string | number, effect: number, extra: Record<string, unknown> = {}) =>
  msg("fight_effect_applied", { target_id: target, effect_id: effect, effect_uid: 42, turns: unsigned(-1), ...extra });

test("the roster tells mobs, players and summons apart", () => {
  const t = opened();
  assert.equal(t.fighters.size, 3);
  assert.equal(t.fighters.get(-1)?.side, "enemy");
  assert.equal(t.fighters.get(-1)?.monsterId, 2386);
  assert.equal(t.fighters.get(ME)?.side, "ally");
  assert.equal(t.fighters.get(MATE)?.side, "ally", "a team mate on my team is an ally");
  assert.equal(t.fighters.get(ME)?.playerName, "Moi");
});

test("a negative fighter id is not collapsed onto its neighbours", () => {
  const t = opened();
  t.handle(applied(SUMMON, 950, { state_id: 1, effect_uid: 7 }));
  assert.ok(t.fighters.has(-2), "-2 is its own fighter, distinct from -1");
  assert.equal(t.fighters.get(-2)?.summon, true);
});

test("a summon's side is left unknown, never guessed from the sign", () => {
  const t = opened();
  t.handle(applied(SUMMON, 950, { state_id: 1, effect_uid: 7 }));
  assert.equal(t.fighters.get(-2)?.side, "unknown");

  // so an "any enemy" rule must not fire on it
  const rule = newRule({ id: "E", trigger: "gained", what: { kind: "any" }, who: { kind: "enemies" } });
  const t2 = opened();
  const events = t2.handle(applied(SUMMON, 950, { state_id: 1, effect_uid: 8 }));
  assert.equal(events.length, 1);
  assert.deepEqual(firing([rule], events[0]!, t2, new Cooldowns(), 0), []);
});

test("effect 950 is a state gained, and its removal pairs back to it", () => {
  const t = opened();
  const gained = t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 14, spell_id: 123 }));
  assert.equal(gained.length, 1);
  assert.deepEqual(
    { ...gained[0]!, ageMs: 0 },
    { trigger: "gained", reason: "applied", kind: "state", id: 7, target: -1,
      spellId: 123, turns: -1, round: 3, ageMs: 0 },
    "turns -1 means until removed",
  );

  const lost = t.handle(msg("fight_effect_removed", { effect_uid: 14, target_id: MOB }));
  assert.equal(lost[0]?.trigger, "lost");
  assert.equal(lost[0]?.reason, "expired");
  assert.equal(lost[0]?.kind, "state");
  assert.equal(lost[0]?.id, 7, "fight_effect_removed carries no state id; it came from our own map");
  assert.equal(t.unpairedRemovals, 0);
});

test("951 is removed by a spell and 952 is only disabled", () => {
  const t = opened();
  assert.equal(t.handle(applied(MOB, 951, { state_id: 7, effect_uid: 15 }))[0]?.reason, "removed_by_spell");
  assert.equal(t.handle(applied(MOB, 952, { state_id: 7, effect_uid: 16 }))[0]?.reason, "disabled");
  for (const r of [951, 952]) {
    const ev = t.handle(applied(MOB, r, { state_id: 7, effect_uid: 17 }))[0]!;
    assert.equal(ev.trigger, "lost");
    assert.equal(ev.kind, "state");
  }
});

test("a plain effect id is a buff, not a state", () => {
  const t = opened();
  const ev = t.handle(applied(MOB, 186, { effect_uid: 20, value: 150 }))[0]!;
  assert.equal(ev.kind, "effect");
  assert.equal(ev.id, 186);
  assert.equal(ev.trigger, "gained");
});

test("a removal we never saw applied is reported, not invented", () => {
  const t = opened();
  const ev = t.handle(msg("fight_effect_removed", { effect_uid: 999, target_id: MOB }))[0]!;
  assert.equal(ev.id, null, "we do not know what it was, so we do not claim to");
  assert.equal(t.unpairedRemovals, 1);

  const specific = newRule({ trigger: "lost", what: { kind: "state", id: 7 }, who: { kind: "any" } });
  const anything = newRule({ trigger: "lost", what: { kind: "any" }, who: { kind: "any" } });
  assert.deepEqual(firing([specific], ev, t, new Cooldowns(), 0), [], "cannot match a named state");
  assert.equal(firing([anything], ev, t, new Cooldowns(), 0).length, 1);
});

test("fight_end clears the fight", () => {
  const t = opened();
  t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 14 }));
  assert.equal(t.inFight, true);
  t.handle(msg("fight_end", {}));
  assert.equal(t.inFight, false);
  assert.equal(t.fighters.size, 0);
});

test("one cast applied three times fires a rule once", () => {
  const t = opened();
  const rule = newRule({ id: "S", trigger: "gained", what: { kind: "state", id: 5380 }, who: { kind: "enemies" } });
  const cd = new Cooldowns();
  let fired = 0;
  // A real capture applied state 5380 three times inside five seconds.
  for (const at of [0, 40, 80, 2000]) {
    const ev = t.handle(applied(MOB, 950, { state_id: 5380, effect_uid: 30 }))[0]!;
    fired += firing([rule], ev, t, cd, at).length;
  }
  assert.equal(fired, 2, "three inside the 1500 ms cooldown collapse to one, the fourth is new");
});

test("a rule can name a monster, which survives from fight to fight", () => {
  const t = opened();
  const ev = t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 31 }))[0]!;
  const right = newRule({ trigger: "gained", what: { kind: "any" }, who: { kind: "monster", monsterId: 2386 } });
  const wrong = newRule({ trigger: "gained", what: { kind: "any" }, who: { kind: "monster", monsterId: 9999 } });
  assert.equal(firing([right], ev, t, new Cooldowns(), 0).length, 1);
  assert.deepEqual(firing([wrong], ev, t, new Cooldowns(), 0), []);
});

test("a disabled rule never fires", () => {
  const t = opened();
  const ev = t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 32 }))[0]!;
  const off = newRule({ enabled: false, trigger: "gained", what: { kind: "any" }, who: { kind: "any" } });
  assert.deepEqual(firing([off], ev, t, new Cooldowns(), 0), []);
});


// ---------------------------------------------------------------------------
// Issue #3: enemies showed up as allies.
//
// The app used fight_placement_positions' `team` field. A real capture proved
// that field is not the team: it only ever holds 1/3/5/7, one message carried
// four distinct values, and message 705950 gave two allied players 7 and 1
// while the monster between them got 3. Sides come from the start cells now.

test("sides come from the placement cells, not from the facing field", () => {
  const t = opened();
  assert.equal(t.fighters.get(ME)?.side, "ally");
  assert.equal(t.fighters.get(MATE)?.side, "ally", "allied even though its facing differs from mine");
  assert.equal(t.fighters.get(-1)?.side, "enemy");
  // The facing really is different for the two allies; that must not matter.
  assert.equal(t.fighters.get(ME)?.facing, 1);
  assert.equal(t.fighters.get(MATE)?.facing, 7);
  assert.equal(t.fighters.get(-1)?.facing, 3);
});

test("a mob placed on our own side is an ally, and one on theirs is not", () => {
  // Fight 511 in the capture really did have monsters on the player's side.
  const t = new FightTracker();
  t.handle(msg("fight_started", { fight_id: 511 }));
  t.handle(msg("fight_placement_cells", { attacker_cells: [120, 177], defender_cells: [346, 388] }));
  t.handle(msg("fighter_info", { fighter_id: ME, cell: 120, player_name: "Moi" }));
  t.handle(msg("fighter_info", { fighter_id: MOB, cell: 177, monster_id: 1134 }));
  t.handle(msg("fighter_info", { fighter_id: unsigned(-6), cell: 346, monster_id: 1136 }));
  t.handle(msg("fight_placement_position_request", { fighter_id: ME, cell: 120 }, "c2s"));

  assert.equal(t.fighters.get(-1)?.side, "ally", "placed in our group");
  assert.equal(t.fighters.get(-6)?.side, "enemy");
});

test("a summon is unknown: it has no placement cell at all", () => {
  const t = opened();
  t.handle(applied(SUMMON, 950, { state_id: 1, effect_uid: 60 }));
  assert.equal(t.fighters.get(-2)?.side, "unknown");
  assert.equal(t.fighters.get(-2)?.cell, null);
});

// ---------------------------------------------------------------------------
// Issue #1: monsters appeared twice when somebody joined the fight.
//
// Straight from a real capture: a second player joins, the server sends
// actor_removed for -1..-4 and then re-announces the SAME four monsters, same
// cells, as -5..-8. Ignoring the removals left both sets in the roster.

test("a player joining does not duplicate the monsters", () => {
  const t = new FightTracker();
  t.handle(msg("fight_started", { fight_id: 2195 }));
  t.handle(msg("fight_placement_cells", { attacker_cells: [453, 395], defender_cells: [427, 385] }));
  t.handle(msg("fighter_info", { fighter_id: unsigned(-1), cell: 427, monster_id: 4459 }));
  t.handle(msg("fighter_info", { fighter_id: unsigned(-2), cell: 385, monster_id: 4459 }));
  t.handle(msg("fighter_info", { fighter_id: ME, cell: 453, player_name: "Moi" }));
  t.handle(msg("fight_placement_position_request", { fighter_id: ME, cell: 453 }, "c2s"));
  assert.equal(t.fighters.size, 3);

  // A second player joins; the old fighters are removed and re-created with new ids.
  t.handle(msg("fighter_info", { fighter_id: MATE, cell: 395, player_name: "Copain" }));
  t.handle(msg("actor_removed", { actor_id: unsigned(-1) }));
  t.handle(msg("actor_removed", { actor_id: unsigned(-2) }));
  t.handle(msg("fighter_info", { fighter_id: unsigned(-5), cell: 427, monster_id: 4459 }));
  t.handle(msg("fighter_info", { fighter_id: unsigned(-6), cell: 385, monster_id: 4459 }));

  const mobs = [...t.fighters.values()].filter((f) => f.monsterId !== null);
  assert.equal(mobs.length, 2, "two monsters, not four");
  assert.deepEqual(mobs.map((f) => f.id).sort((a, b) => a - b), [-6, -5]);
  assert.equal(t.fighters.get(MATE)?.side, "ally", "and the joiner is on our side");
});

test("actor_removed for someone who is not a fighter changes nothing", () => {
  // Out of combat the same message announces actors leaving the map.
  const t = opened();
  const before = t.fighters.size;
  t.handle(msg("actor_removed", { actor_id: 999999 }));
  assert.equal(t.fighters.size, before);
});

test("a removed fighter takes its live effects with it", () => {
  const t = opened();
  t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 70 }));
  assert.equal(t.liveEffects().length, 1);
  t.handle(msg("actor_removed", { actor_id: MOB }));
  assert.equal(t.liveEffects().length, 0, "otherwise its removal would pair to a ghost");
});

// ---------------------------------------------------------------------------
// Issue #5: several ids share one name, and you cannot know which one a spell
// will produce. A rule on the NAME covers all of them.

/** The catalog really does hold six states called "Invulnérable". */
const CATALOG: Record<string, string> = {
  "state:56": "Invulnérable", "state:269": "Invulnérable", "state:365": "Invulnérable",
  "state:7": "Pesanteur", "state:5194": "Toxines I", "effect:186": "- Puissance",
};
const nameOf = (kind: "state" | "effect", id: number) => CATALOG[`${kind}:${id}`] ?? null;

test("a rule on a name fires for every id carrying it", () => {
  const rule = newRule({ id: "N", trigger: "gained", what: { kind: "state", name: "Invulnérable" }, who: { kind: "any" } });
  for (const id of [56, 269, 365]) {
    const t = opened();
    const ev = t.handle(applied(MOB, 950, { state_id: id, effect_uid: 80 + id }))[0]!;
    assert.equal(firing([rule], ev, t, new Cooldowns(), 0, nameOf).length, 1, `state ${id}`);
  }
});

test("a name rule does not fire for a different name", () => {
  const rule = newRule({ trigger: "gained", what: { kind: "state", name: "Invulnérable" }, who: { kind: "any" } });
  const t = opened();
  const ev = t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 90 }))[0]!;
  assert.deepEqual(firing([rule], ev, t, new Cooldowns(), 0, nameOf), []);
});

test("two variants of the same name landing together alert once", () => {
  const rule = newRule({ id: "N", trigger: "gained", what: { kind: "state", name: "Invulnérable" }, who: { kind: "any" } });
  const t = opened();
  const cd = new Cooldowns();
  const a = t.handle(applied(MOB, 950, { state_id: 56, effect_uid: 91 }))[0]!;
  const b = t.handle(applied(MOB, 950, { state_id: 269, effect_uid: 92 }))[0]!;
  assert.equal(firing([rule], a, t, cd, 0, nameOf).length, 1);
  assert.deepEqual(firing([rule], b, t, cd, 50, nameOf), [], "same name, still one thing");
});

test("an id rule still works, and is not affected by the name of another id", () => {
  const rule = newRule({ trigger: "gained", what: { kind: "state", id: 56 }, who: { kind: "any" } });
  const t = opened();
  const hit = t.handle(applied(MOB, 950, { state_id: 56, effect_uid: 93 }))[0]!;
  const miss = t.handle(applied(MOB, 950, { state_id: 269, effect_uid: 94 }))[0]!;
  assert.equal(firing([rule], hit, t, new Cooldowns(), 0, nameOf).length, 1);
  assert.deepEqual(firing([rule], miss, t, new Cooldowns(), 0, nameOf), []);
});

test("a name rule cannot fire when the id resolves to nothing", () => {
  // 233 of the 872 effects have no name in the game data at all.
  const rule = newRule({ trigger: "gained", what: { kind: "effect", name: "- Puissance" }, who: { kind: "any" } });
  const t = opened();
  const ev = t.handle(applied(MOB, 792, { effect_uid: 95 }))[0]!;
  assert.deepEqual(firing([rule], ev, t, new Cooldowns(), 0, nameOf), []);
});

// ---------------------------------------------------------------------------
// Ranks: a spell that evolves through Toxines I..V is one thing to alert on.
// Proven from the Capitaine Meno fight, where the mob goes
//   r2 lost Toxines I -> r2 gained Toxines II -> r3 lost II -> r3 gained III
// while "Toxines rang 2" is on the CASTER and never touches the mob at all.

const TOXINES: Record<string, string> = {
  "state:5194": "Toxines I", "state:5195": "Toxines II", "state:5196": "Toxines III",
  "state:2764": "Toxines rang 2", "state:612": "Toxines réappliquées",
  "state:7": "Pesanteur",
};
const toxNameOf = (k: "state" | "effect", id: number) => TOXINES[`${k}:${id}`] ?? null;

test("family() strips ranks but not meaning", () => {
  assert.equal(family("Toxines I"), "Toxines");
  assert.equal(family("Toxines V"), "Toxines");
  assert.equal(family("Toxines rang 2"), "Toxines");
  assert.equal(family("Souffrance 6+"), "Souffrance");
  assert.equal(family("Mutilation I"), "Mutilation");
  // not ranks:
  assert.equal(family("Toxines réappliquées"), "Toxines réappliquées");
  assert.equal(family("Invulnérable en Mêlée"), "Invulnérable en Mêlée");
  assert.equal(family("Flèche Boomerang (masque)"), "Flèche Boomerang (masque)");
});

test("one rule on Toxines catches every rank", () => {
  const rule = newRule({ id: "T", trigger: "lost", what: { kind: "state", name: "Toxines" }, who: { kind: "any" } });
  const cd = new Cooldowns();
  let fired = 0;
  const t = opened();
  // the real sequence: gain I, lose I, gain II, lose II, gain III
  const script: [number, number][] = [[5194, 1], [5194, 0], [5195, 1], [5195, 0], [5196, 1]];
  let at = 0;
  for (const [state, gain] of script) {
    at += 5000;
    const ev = gain
      ? t.handle(applied(MOB, 950, { state_id: state, effect_uid: state }))[0]!
      : t.handle(msg("fight_effect_removed", { effect_uid: state, target_id: MOB }))[0]!;
    fired += firing([rule], ev, t, cd, at, toxNameOf).length;
  }
  assert.equal(fired, 2, "the two losses fire; the gains do not");
});

test("a rule written against one rank still only means that family", () => {
  // The user's saved rule said "Toxines rang 2"; that is the Toxines family.
  const rule = newRule({ trigger: "lost", what: { kind: "state", name: "Toxines rang 2" }, who: { kind: "any" } });
  const t = opened();
  t.handle(applied(MOB, 950, { state_id: 5194, effect_uid: 5194 }));
  const ev = t.handle(msg("fight_effect_removed", { effect_uid: 5194, target_id: MOB }))[0]!;
  assert.equal(firing([rule], ev, t, new Cooldowns(), 0, toxNameOf).length, 1);
});

test("a different Toxines state is not folded in", () => {
  const rule = newRule({ trigger: "gained", what: { kind: "state", name: "Toxines" }, who: { kind: "any" } });
  const t = opened();
  const ev = t.handle(applied(MOB, 950, { state_id: 612, effect_uid: 612 }))[0]!;
  assert.deepEqual(firing([rule], ev, t, new Cooldowns(), 0, toxNameOf), [],
    "'Toxines réappliquées' is not a rank of Toxines");
});

// ---------------------------------------------------------------------------
// "Moi": your own characters, matched by name. The user multi-accounts, so it
// is a set. No protocol message identifies the logged-in character - the c2s
// placement request looked like it did, but a real capture has our own client
// sending it for monsters (-1, -4, -5) and for other players. So the set is
// seeded from that message only when it names a PLAYER, and is correctable.

test("a player we placed ourselves is seeded as our own", () => {
  const t = opened();   // opened() sends a c2s placement request for ME
  assert.equal(t.fighters.get(ME)?.own, true);
  assert.equal(t.fighters.get(MATE)?.own, false, "a team mate is an ally, not me");
  assert.equal(t.fighters.get(-1)?.own, false);
  assert.deepEqual([...t.ownNames], ["Moi"]);
});

test("a monster named in our own placement request is never us", () => {
  // Straight from the capture: our client sent this for -1, -4 and -5.
  const t = opened();
  t.handle(msg("fight_placement_position_request", { fighter_id: MOB, cell: 100 }, "c2s"));
  assert.equal(t.fighters.get(-1)?.own, false);
  assert.equal(t.fighters.get(-1)?.side, "enemy", "and it must not flip which side is ours");
  assert.deepEqual([...t.ownNames], ["Moi"]);
});

test("a rule on 'moi' fires only for our own characters", () => {
  const rule = newRule({ trigger: "gained", what: { kind: "any" }, who: { kind: "self" } });
  const t = opened();
  const mine = t.handle(applied(ME, 950, { state_id: 7, effect_uid: 100 }))[0]!;
  const mate = t.handle(applied(MATE, 950, { state_id: 7, effect_uid: 101 }))[0]!;
  const mob = t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 102 }))[0]!;
  assert.equal(firing([rule], mine, t, new Cooldowns(), 0).length, 1);
  assert.deepEqual(firing([rule], mate, t, new Cooldowns(), 0), []);
  assert.deepEqual(firing([rule], mob, t, new Cooldowns(), 0), []);
});

test("you can correct who you are, and several characters can be yours", () => {
  const t = opened();
  t.setOwn("Copain", true);
  assert.equal(t.fighters.get(MATE)?.own, true, "multi-accounting");
  t.setOwn("Moi", false);
  assert.equal(t.fighters.get(ME)?.own, false, "and a wrong guess can be undone");
});

test("our characters are remembered for a fight we joined too late to watch", () => {
  const first = opened();
  const later = new FightTracker();
  for (const n of first.ownNames) later.ownNames.add(n);
  later.handle(msg("fight_started", { fight_id: 2 }));
  later.handle(msg("fighter_info", { fighter_id: ME, cell: 300, player_name: "Moi" }));
  assert.equal(later.fighters.get(ME)?.own, true, "still me, with no placement traffic at all");
});

// ---------------------------------------------------------------------------
// Issue #2: ET / OU conditions, built by merging rules.
//
// The case that prompted it, from the Capitaine Meno fight: Toxines climbs a
// rank each time the mob takes a trap, and you only want to hear about it
// under some circumstances.

const TOX2: Record<string, string> = {
  "state:5194": "Toxines I", "state:5195": "Toxines II", "state:5196": "Toxines III",
  "state:5198": "Toxines V", "state:612": "Toxines réappliquées", "state:7": "Pesanteur",
};
const tox2 = (k: "state" | "effect", id: number) => TOX2[`${k}:${id}`] ?? null;

const trigger = () => newRule({ id: "A", label: "Meno gagne Toxines", trigger: "gained",
  what: { kind: "state", name: "Toxines" }, who: { kind: "monster", monsterId: 2386 } });
const hasReapplied = () => newRule({ id: "B", label: "a Toxines réappliquées", trigger: "gained",
  what: { kind: "state", name: "Toxines réappliquées" }, who: { kind: "monster", monsterId: 2386 } });
const hasPesanteur = () => newRule({ id: "C", label: "a Pesanteur", trigger: "gained",
  what: { kind: "state", name: "Pesanteur" }, who: { kind: "monster", monsterId: 2386 } });

test("merging with ET turns the other rules into conditions on the target", () => {
  const r = merge(trigger(), [hasReapplied()], "and");
  assert.equal(r.id, "A", "the first rule stays the trigger, with its own sound and label");
  assert.equal(r.conditions?.length, 1);
  assert.equal(r.conditions![0]!.length, 1);
  assert.deepEqual(r.conditions![0]![0]!.who, { kind: "target" },
    "same aim as the trigger, so it means THIS fighter, not any mob of that kind");
  assert.equal(r.conditions![0]![0]!.present, true);
});

test("a merged ET rule fires only while the condition holds", () => {
  const rule = merge(trigger(), [hasReapplied()], "and");
  const t = opened();
  const cd = new Cooldowns();

  // no Toxines réappliquées yet -> silent
  const first = t.handle(applied(MOB, 950, { state_id: 5194, effect_uid: 1 }))[0]!;
  assert.deepEqual(firing([rule], first, t, cd, 0, tox2), []);

  // now it has it -> the next rank fires
  t.handle(applied(MOB, 950, { state_id: 612, effect_uid: 2 }));
  const second = t.handle(applied(MOB, 950, { state_id: 5195, effect_uid: 3 }))[0]!;
  assert.equal(firing([rule], second, t, cd, 9000, tox2).length, 1);
});

test("merging with OU opens a second branch, and either one is enough", () => {
  const rule = merge(merge(trigger(), [hasReapplied()], "and"), [hasPesanteur()], "or");
  assert.equal(rule.conditions?.length, 2);

  const t = opened();
  const cd = new Cooldowns();
  // neither branch satisfied
  const a = t.handle(applied(MOB, 950, { state_id: 5194, effect_uid: 10 }))[0]!;
  assert.deepEqual(firing([rule], a, t, cd, 0, tox2), []);
  // only the second branch
  t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 11 }));
  const b = t.handle(applied(MOB, 950, { state_id: 5195, effect_uid: 12 }))[0]!;
  assert.equal(firing([rule], b, t, cd, 9000, tox2).length, 1);
});

test("a second ET merge extends the same branch, so both must hold", () => {
  const rule = merge(merge(trigger(), [hasReapplied()], "and"), [hasPesanteur()], "and");
  assert.equal(rule.conditions?.length, 1);
  assert.equal(rule.conditions![0]!.length, 2);

  const t = opened();
  const cd = new Cooldowns();
  t.handle(applied(MOB, 950, { state_id: 612, effect_uid: 20 }));
  const one = t.handle(applied(MOB, 950, { state_id: 5195, effect_uid: 21 }))[0]!;
  assert.deepEqual(firing([rule], one, t, cd, 0, tox2), [], "only one of the two holds");

  t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 22 }));
  const both = t.handle(applied(MOB, 950, { state_id: 5196, effect_uid: 23 }))[0]!;
  assert.equal(firing([rule], both, t, cd, 9000, tox2).length, 1);
});

test("a state removed by a spell stops counting as carried", () => {
  const rule = merge(trigger(), [hasReapplied()], "and");
  const t = opened();
  const cd = new Cooldowns();
  t.handle(applied(MOB, 950, { state_id: 612, effect_uid: 30 }));
  // effect 951: a spell removes it. It carries its OWN uid, not uid 30.
  t.handle(applied(MOB, 951, { state_id: 612, effect_uid: 31 }));
  const ev = t.handle(applied(MOB, 950, { state_id: 5195, effect_uid: 32 }))[0]!;
  assert.deepEqual(firing([rule], ev, t, cd, 0, tox2), [], "it no longer has it");
});

test("a state merely disabled (952) does not count as carried either", () => {
  const rule = merge(trigger(), [hasReapplied()], "and");
  const t = opened();
  t.handle(applied(MOB, 950, { state_id: 612, effect_uid: 40 }));
  t.handle(applied(MOB, 952, { state_id: 612, effect_uid: 41 }));
  const ev = t.handle(applied(MOB, 950, { state_id: 5195, effect_uid: 42 }))[0]!;
  assert.deepEqual(firing([rule], ev, t, new Cooldowns(), 0, tox2), [], "suppressed is not carried");
});

test("a 'n'a pas' condition is the useful direction for Toxines", () => {
  // Note the `exact`: without it "Toxines V" would mean the whole Toxines
  // family, and the mob always carries SOME rank, so the rule would be dead.
  let rule = merge(trigger(), [newRule({ id: "D", what: { kind: "state", name: "Toxines V", exact: true },
    who: { kind: "monster", monsterId: 2386 } })], "and");
  rule = { ...rule, conditions: [[{ ...rule.conditions![0]![0]!, present: false }]] };

  const t = opened();
  const cd = new Cooldowns();
  const early = t.handle(applied(MOB, 950, { state_id: 5195, effect_uid: 50 }))[0]!;
  assert.equal(firing([rule], early, t, cd, 0, tox2).length, 1, "not maxed yet, tell me");
  // Toxines V and Toxines II are the same family, so reaching V satisfies it.
  t.handle(applied(MOB, 950, { state_id: 5198, effect_uid: 51 }));
  const late = t.handle(applied(MOB, 950, { state_id: 5196, effect_uid: 52 }))[0]!;
  assert.deepEqual(firing([rule], late, t, cd, 9000, tox2), [], "already maxed, stay quiet");
});

test("a conditioned rule refuses to fire when we joined the fight late", () => {
  const t = new FightTracker();          // no fight_started at all
  t.handle(msg("fighter_info", { fighter_id: MOB, cell: 100, monster_id: 2386 }));
  assert.equal(t.sawStart, false);
  const ev = t.handle(applied(MOB, 950, { state_id: 5195, effect_uid: 60 }))[0]!;

  const plain = trigger();
  const conditioned = merge(trigger(), [hasReapplied()], "and");
  assert.equal(firing([plain], ev, t, new Cooldowns(), 0, tox2).length, 1,
    "a rule without conditions still works");
  assert.deepEqual(firing([conditioned], ev, t, new Cooldowns(), 0, tox2), [],
    "but we cannot know what it carries, so we do not guess");
});

test("an exact condition keeps the rank, a family one does not", () => {
  const t = opened();
  t.handle(applied(MOB, 950, { state_id: 5195, effect_uid: 70 }));   // Toxines II
  const ev = t.handle(applied(MOB, 950, { state_id: 5196, effect_uid: 71 }))[0]!;

  const exact = merge(trigger(), [newRule({ what: { kind: "state", name: "Toxines V", exact: true },
    who: { kind: "monster", monsterId: 2386 } })], "and");
  const loose = merge(trigger(), [newRule({ what: { kind: "state", name: "Toxines V" },
    who: { kind: "monster", monsterId: 2386 } })], "and");

  assert.deepEqual(firing([exact], ev, t, new Cooldowns(), 0, tox2), [],
    "it is not at V, so an exact 'has V' is false");
  assert.equal(firing([loose], ev, t, new Cooldowns(), 0, tox2).length, 1,
    "without exact, any Toxines rank satisfies it");
});

// ---------------------------------------------------------------------------
// Telling a real loss from a rank going up.
//
// On the Capitaine Meno fight, every rank step put Toxines back within 0-1 ms,
// while the one time the Sram misplayed it stayed gone for 45 SECONDS. So
// "alert me when it is lost" has to wait and look again, or it fires on every
// step of the ladder.

test("a rank step is not a loss once you confirm it", () => {
  const rule = newRule({ id: "L", trigger: "lost",
    what: { kind: "state", name: "Toxines" }, who: { kind: "monster", monsterId: 2386 },
    confirmMs: 1500 });

  const t = opened();
  t.handle(applied(MOB, 950, { state_id: 5194, effect_uid: 200 }));        // Toxines I
  const lost = t.handle(msg("fight_effect_removed", { effect_uid: 200, target_id: MOB }))[0]!;
  assert.equal(firing([rule], lost, t, new Cooldowns(), 0, tox2).length, 1, "it did fire the match");

  // ...but 1 ms later Toxines II lands, exactly as the capture shows.
  t.handle(applied(MOB, 950, { state_id: 5195, effect_uid: 201 }));
  assert.equal(stillTrue(rule, lost, t, tox2), false, "so nothing should sound");
});

test("a real loss survives the confirmation", () => {
  const rule = newRule({ id: "L", trigger: "lost",
    what: { kind: "state", name: "Toxines" }, who: { kind: "monster", monsterId: 2386 },
    confirmMs: 1500 });

  const t = opened();
  t.handle(applied(MOB, 950, { state_id: 5196, effect_uid: 210 }));        // Toxines III
  const lost = t.handle(msg("fight_effect_removed", { effect_uid: 210, target_id: MOB }))[0]!;
  assert.equal(firing([rule], lost, t, new Cooldowns(), 0, tox2).length, 1);
  // nothing comes back - the r5 misplay
  assert.equal(stillTrue(rule, lost, t, tox2), true, "this is the one to shout about");
});

test("confirmation also works the other way round for a gain", () => {
  const rule = newRule({ trigger: "gained", what: { kind: "state", name: "Pesanteur" },
    who: { kind: "any" }, confirmMs: 1000 });
  const t = opened();
  const gained = t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 220 }))[0]!;
  assert.equal(stillTrue(rule, gained, t, tox2), true, "still on the target");
  t.handle(msg("fight_effect_removed", { effect_uid: 220, target_id: MOB }));
  assert.equal(stillTrue(rule, gained, t, tox2), false, "dispelled straight away, do not bother me");
});

test("confirmation re-checks the conditions when the rule has some", () => {
  const rule = merge(
    newRule({ id: "A", trigger: "lost", what: { kind: "state", name: "Toxines" },
      who: { kind: "monster", monsterId: 2386 }, confirmMs: 1500 }),
    [newRule({ what: { kind: "state", name: "Pesanteur" }, who: { kind: "monster", monsterId: 2386 } })],
    "and");

  const t = opened();
  t.handle(applied(MOB, 950, { state_id: 5194, effect_uid: 230 }));
  const lost = t.handle(msg("fight_effect_removed", { effect_uid: 230, target_id: MOB }))[0]!;
  assert.equal(stillTrue(rule, lost, t, tox2), false, "no Pesanteur, condition fails");
  t.handle(applied(MOB, 950, { state_id: 7, effect_uid: 231 }));
  assert.equal(stillTrue(rule, lost, t, tox2), true);
});
