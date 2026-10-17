import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROLES } from "../../src/server/domain/roles.ts";

const root = join(import.meta.dirname, "../../skills");

test("every skill the code selects exists, and BB's rule holds: folder name == frontmatter name", () => {
  // BB skips a skill whose folder and frontmatter names differ, and configure() then fails on the unknown id
  // (seen live on BB 0.46.1: the session got no Helm tools at all).
  const wanted = new Set(["helm", "helm-lead", ...Object.values(ROLES).map((r) => r.skill)]);
  for (const name of wanted) {
    const file = join(root, name, "SKILL.md");
    assert.ok(existsSync(file), `${file} is missing`);
    const fm = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${name}: no frontmatter`);
    assert.match(fm![1], new RegExp(`^name:\\s*${name}\\s*$`, "m"), `${name}: frontmatter name must equal the folder name`);
    assert.match(fm![1], /^description:\s*\S/m, `${name}: needs a description`);
  }
  for (const dir of readdirSync(root).filter((d) => !d.startsWith("."))) {
    const fm = readFileSync(join(root, dir, "SKILL.md"), "utf8").match(/^name:\s*(\S+)/m);
    assert.equal(fm?.[1], dir, `skills/${dir}: frontmatter name ${fm?.[1]} differs from the folder`);
  }
});

test("every skill's frontmatter is valid YAML that BB can read (no bare ': ' or ' #' in a plain value)", () => {
  // Seen live: a description containing "the user: interview them" is invalid YAML. BB then read
  // name/description as undefined, skipped the skill, and every configure() that selected it failed;
  // the provider restart that followed killed two running agents' turns ("turn.submit failed").
  for (const dir of readdirSync(root).filter((d) => !d.startsWith("."))) {
    const fm = readFileSync(join(root, dir, "SKILL.md"), "utf8").match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${dir}: no frontmatter`);
    for (const line of fm![1].split("\n")) {
      const m = line.match(/^([a-zA-Z_-]+):\s(.*)$/);
      assert.ok(m, `${dir}: frontmatter line is not "key: value": ${line}`);
      const v = m![2];
      if (/^(["']).*\1$/.test(v)) continue; // quoted scalars may contain anything
      assert.ok(!v.includes(": "), `${dir}: ${m![1]} contains ": " — reword it or quote the value`);
      assert.ok(!v.includes(" #"), `${dir}: ${m![1]} contains " #" (a YAML comment) — reword it or quote the value`);
      assert.ok(!/^[&*!|>%@`[{,?-]/.test(v), `${dir}: ${m![1]} starts with a YAML indicator character — quote it`);
    }
  }
});
