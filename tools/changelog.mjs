/** Build the release notes for a tag, from the commits since the previous one.
 *
 *     node tools/changelog.mjs [tag] > notes.md
 *
 * GitHub's own --generate-notes groups by pull request, and this repo is worked
 * on by committing straight to the branch, so it would just print a flat list.
 * This groups by conventional-commit prefix instead, and falls back to "Other"
 * for anything that does not use one - so unprefixed commits are never dropped.
 */

import { execFileSync } from "node:child_process";

// stdio: git's own "fatal: no names found" on the first release is expected,
// and printing it into the release notes step would just look like a failure.
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const tag = process.argv[2] ?? git("describe", "--tags", "--abbrev=0");
if (!tag) throw new Error("no tag given and none found; pass one: node tools/changelog.mjs v1.2.3");

let previous = null;
try {
  previous = git("describe", "--tags", "--abbrev=0", `${tag}^`);
} catch {
  // First release: everything up to this tag is the changelog.
}

const range = previous ? `${previous}..${tag}` : tag;
const lines = git("log", range, "--no-merges", "--pretty=format:%s\x1f%h").split("\n").filter(Boolean);

const GROUPS = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build and tooling"],
  ["ci", "Build and tooling"],
  ["chore", "Build and tooling"],
];

const buckets = new Map();
for (const line of lines) {
  const [subject, hash] = line.split("\x1f");
  // "feat(rules): do a thing" -> prefix "feat", rest "do a thing"
  const m = /^(\w+)(\([^)]*\))?!?:\s*(.+)$/.exec(subject ?? "");
  const found = m && GROUPS.find(([key]) => key === m[1].toLowerCase());
  const title = found ? found[1] : "Other";
  const scope = m?.[2] ? `**${m[2].slice(1, -1)}** ` : "";
  const text = found ? `${scope}${m[3]}` : subject;
  if (!buckets.has(title)) buckets.set(title, []);
  buckets.get(title).push(`- ${text} (${hash})`);
}

const order = [...new Set(GROUPS.map(([, t]) => t)), "Other"];
const out = [];
for (const title of order) {
  if (!buckets.has(title)) continue;
  out.push(`### ${title}`, "", ...buckets.get(title), "");
}
if (!out.length) out.push("_No recorded change._", "");

out.push(
  "---",
  "",
  "**Install** — `-setup.exe` installs the app; `-portable.exe` runs without installing anything.",
  "",
  "Windows SmartScreen will warn on first run: the binaries are not signed.",
  "Needs a Dofus 3 sniffer listening on 127.0.0.1:8765 (separate, non-public project).",
  "",
  previous
    ? `Changes since [${previous}](../../compare/${previous}...${tag}) · ${lines.length} commit(s).`
    : `First release · ${lines.length} commit(s).`,
);

process.stdout.write(out.join("\n") + "\n");
