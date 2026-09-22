import test from "node:test";
import assert from "node:assert/strict";
import { parseKeepingBigInts, signedId, list } from "../src/json.js";

test("negative fighter ids survive the parse", () => {
  // -1 and -21 as the sniffer sends them. Plain JSON.parse makes these equal.
  const raw = '{"a":18446744073709551615,"b":18446744073709551595,"c":1000000001}';
  assert.notEqual((JSON.parse(raw) as any).a - 2 ** 64, -1, "precondition: JSON.parse is lossy");

  const o = parseKeepingBigInts(raw) as Record<string, unknown>;
  assert.equal(signedId(o.a), -1);
  assert.equal(signedId(o.b), -21);
  assert.equal(signedId(o.c), 1000000001, "a real character id is not touched");
});

test("only value-position integers are rewritten", () => {
  const o = parseKeepingBigInts(
    '{"1234567890123456789":"1234567890123456789","n":1234567890123456789,"s":"x1234567890123456789"}',
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(o)[0], "1234567890123456789", "a long key stays a key");
  assert.equal(o["1234567890123456789"], "1234567890123456789", "a quoted value stays as it was");
  assert.equal(o.n, "1234567890123456789", "an unquoted big value becomes a string");
  assert.equal(o.s, "x1234567890123456789");
});

test("ordinary JSON is untouched", () => {
  const raw = '{"a":[1,2,-3],"b":1.5e10,"c":null,"d":true,"e":"say \\"hi\\": 18446744073709551615"}';
  assert.deepEqual(parseKeepingBigInts(raw), JSON.parse(raw));
});

test("turns -1 means until removed", () => {
  const o = parseKeepingBigInts('{"turns":18446744073709551615}') as Record<string, unknown>;
  assert.equal(signedId(o.turns), -1);
});

test("list normalises repeated fields", () => {
  assert.deepEqual(list(undefined), []);
  assert.deepEqual(list(7), [7]);
  assert.deepEqual(list([7, 3]), [7, 3]);
});
