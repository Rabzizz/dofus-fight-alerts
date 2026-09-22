import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/config.js";
import { newRule } from "../src/rules.js";

const fresh = async () => new Store(await mkdtemp(path.join(tmpdir(), "dfa-")));

test("a rule saved in one run is there in the next", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dfa-"));

  const first = new Store(dir);
  await first.load();
  assert.deepEqual(first.settings.rules, [], "nothing saved yet");
  await first.save({
    rules: [newRule({ id: "keep-me", label: "Boss invulnérable", trigger: "lost",
                      what: { kind: "state", id: 56 }, who: { kind: "enemies" },
                      sound: "cloche.wav" })],
    volume: 0.4,
  });

  // A completely separate Store, as a second launch of the app would be.
  const second = new Store(dir);
  await second.load();
  assert.equal(second.loadProblem, null);
  assert.equal(second.settings.rules.length, 1);
  assert.equal(second.settings.rules[0]?.id, "keep-me");
  assert.equal(second.settings.rules[0]?.sound, "cloche.wav");
  assert.equal(second.settings.rules[0]?.what.kind, "state");
  assert.equal(second.settings.volume, 0.4, "settings persist too, not just rules");
});

test("a first run reports no problem", async () => {
  const store = await fresh();
  await store.load();
  assert.equal(store.loadProblem, null, "a missing file is normal, not an error");
});

test("a corrupt settings file keeps a copy and says so", async () => {
  const store = await fresh();
  await writeFile(store.file, '{"rules": [ THIS IS NOT JSON', "utf8");
  await store.load();

  assert.notEqual(store.loadProblem, null, "the user must be told");
  assert.match(store.loadProblem!, /copie/, "and told where the copy is");
  const backups = (await readdir(path.dirname(store.file))).filter((f) => f.includes(".corrupt-"));
  assert.equal(backups.length, 1, "the bad file is kept, not silently dropped");
  assert.match(await readFile(path.join(path.dirname(store.file), backups[0]!), "utf8"), /NOT JSON/);
});

test("malformed rules are skipped, the good ones survive", async () => {
  const store = await fresh();
  const good = newRule({ id: "good" });
  await writeFile(store.file, JSON.stringify({ rules: [good, { id: "broken" }, null] }), "utf8");
  await store.load();

  assert.equal(store.settings.rules.length, 1);
  assert.equal(store.settings.rules[0]?.id, "good");
  assert.match(store.loadProblem!, /2 regle/, "and it says how many were dropped");
});

test("a save leaves no temp file behind", async () => {
  const store = await fresh();
  await store.load();
  await store.save({ rules: [newRule({ id: "a" })] });
  const left = await readdir(path.dirname(store.file));
  assert.equal(left.filter((f) => f.endsWith(".tmp")).length, 0);
  assert.ok(left.includes("settings.json"));
});
