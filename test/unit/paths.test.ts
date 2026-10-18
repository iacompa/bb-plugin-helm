import { test } from "node:test";
import assert from "node:assert/strict";
import { expandTilde, isInside, samePath, targetPathProblem } from "../../src/shared/paths.ts";

const HOME = "/Users/someone";

test("app folders may be anywhere except the disk root, the home folder itself and system folders", () => {
  for (const ok of ["/Volumes/💾Team's Disk/Work/app builds/studio/lumen", "~/code/tide", "/Users/someone/Projects/x", "/tmp/helm/x", "/var/folders/ab/T/x", "D:\\work\\app"]) assert.equal(targetPathProblem(ok, HOME), null, ok);
  const bad: Array<[string, RegExp]> = [
    ["/", /root of the disk/],
    ["~", /home folder/],
    ["/Users/someone/", /home folder/],
    ["/Volumes/SSD", /top of a disk/],
    ["/usr/local/app", /system folder \/usr/],
    ["/System/Library/x", /system folder/],
    ["/Applications/Thing", /system folder/],
    ["relative/path", /not an absolute path/],
    ["C:\\Windows\\System32\\x", /Windows system folder/],
    ["/Users/someone/../../etc/x", /system folder \/etc/],
  ];
  for (const [p, re] of bad) assert.match(targetPathProblem(p, HOME) ?? "", re, p);
  assert.match(targetPathProblem("~/x", null) ?? "", /home folder is unknown/);
});

test("path helpers", () => {
  assert.equal(expandTilde("~/a", HOME), "/Users/someone/a");
  assert.ok(samePath("~/a/", "/Users/someone/a", HOME));
  assert.ok(isInside("/disk/dup/inner", "/disk/dup", HOME));
  assert.ok(!isInside("/disk/dupe", "/disk/dup", HOME));
});
