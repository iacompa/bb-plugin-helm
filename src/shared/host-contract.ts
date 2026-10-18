// The contract between the plugin server and Helm's host entry (host.ts), which
// runs inside each BB host daemon and does the git and filesystem work (V16).
// The server never runs commands itself; it calls these methods through
// bb.hosts.experimental_client(...).call(method, input, { hostId }).

import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

const RepoFile = z.object({ path: z.string().min(1).max(400), content: z.string().max(2_000_000), executable: z.boolean().optional() });

const ScanFindingZ = z.object({
  rule: z.string(),
  ruleId: z.string(),
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  path: z.string(),
  line: z.number(),
  quote: z.string(),
  why: z.string(),
  fix: z.string(),
});

export const SimPlatformZ = z.enum(["ios", "and", "mac", "win"]);
/** A simulator udid, an AVD name, an adb serial, or "local" for this Mac. */
export const SimIdZ = z.string().min(1).max(120).regex(/^[\w.:-]+$/);
const SimDeviceZ = z.object({ id: z.string(), name: z.string(), detail: z.string(), booted: z.boolean() });
export const SimListZ = z.object({
  host: z.string(),
  ios: z.array(SimDeviceZ),
  and: z.array(SimDeviceZ),
  tools: z.object({ simctl: z.boolean(), adb: z.boolean(), emulator: z.boolean(), idb: z.boolean(), screencapture: z.boolean() }),
});
export type SimList = z.output<typeof SimListZ>;
export type SimPlatform = z.output<typeof SimPlatformZ>;

export const HOST_CONTRACT = defineRpcContract({
  ensureRepo: {
    input: z.object({ path: z.string().min(1), files: z.array(RepoFile).max(500), message: z.string().max(200) }),
    output: z.object({ created: z.boolean(), head: z.string().nullable(), branch: z.string().nullable() }),
  },
  /** What is at a folder the human named for an app (read-only). */
  inspectPath: {
    input: z.object({ path: z.string().min(1).max(1000) }),
    output: z.object({
      path: z.string(),
      exists: z.boolean(),
      isDir: z.boolean(),
      empty: z.boolean(),
      gitRoot: z.string().nullable(),
      head: z.string().nullable(),
      branch: z.string().nullable(),
      dirty: z.number(),
      writable: z.boolean(),
      /** For a missing folder: the repository its nearest existing parent is inside, if any. */
      enclosingRepo: z.string().nullable().optional(),
    }),
  },
  /**
   * Adopt an existing repository: create `branch` at HEAD plus Helm's files (only
   * those missing at HEAD) without touching the working tree, the index or HEAD.
   * Idempotent: an existing branch is returned as it is.
   */
  adoptRepo: {
    input: z.object({ path: z.string().min(1), branch: z.string().min(1).max(200), files: z.array(RepoFile).max(50), message: z.string().max(200) }),
    output: z.object({ created: z.boolean(), head: z.string(), base: z.string(), userBranch: z.string().nullable() }),
  },
  revParse: {
    input: z.object({ repo: z.string().min(1), ref: z.string().min(1).max(300) }),
    output: z.object({ sha: z.string().nullable() }),
  },
  isAncestor: {
    input: z.object({ repo: z.string().min(1), ancestor: z.string().min(1), descendant: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  },
  fileAt: {
    input: z.object({ repo: z.string().min(1), ref: z.string().min(1), path: z.string().min(1), maxBytes: z.number().int().positive().max(4_000_000).optional() }),
    output: z.object({ content: z.string().nullable() }),
  },
  status: {
    input: z.object({ path: z.string().min(1) }),
    output: z.object({ head: z.string().nullable(), branch: z.string().nullable(), clean: z.boolean(), dirty: z.array(z.string()) }),
  },
  readFile: {
    input: z.object({ path: z.string().min(1), maxBytes: z.number().int().positive().max(4_000_000).optional() }),
    output: z.object({ content: z.string().nullable() }),
  },
  writeFile: {
    input: z.object({ path: z.string().min(1), content: z.string().max(2_000_000) }),
    output: z.object({ ok: z.boolean() }),
  },
  log: {
    input: z.object({ repo: z.string().min(1), ref: z.string().min(1), limit: z.number().int().min(1).max(200) }),
    output: z.object({ commits: z.array(z.object({ sha: z.string(), subject: z.string(), ts: z.number() })) }),
  },
  scan: {
    input: z.object({ repo: z.string().min(1), ref: z.string().min(1), paths: z.array(z.string()).max(500).optional(), history: z.boolean().optional() }),
    output: z.object({
      commit: z.string().nullable(),
      findings: z.array(ScanFindingZ),
      filesScanned: z.number(),
      shippedFiles: z.number(),
      exempted: z.number(),
      unverified: z.array(z.string()),
    }),
  },
  probe: {
    input: z.object({}),
    output: z.object({
      platform: z.string(),
      home: z.string().nullable(),
      git: z.string().nullable(),
      xcode: z.string().nullable(),
      swift: z.string().nullable(),
      gradle: z.string().nullable(),
      androidSdk: z.boolean(),
      dotnet: z.string().nullable(),
    }),
  },
  // ── simulator view (the human watches and drives the apps) ──
  simList: {
    input: z.object({}),
    output: SimListZ,
  },
  simBoot: {
    input: z.object({ platform: SimPlatformZ, id: SimIdZ }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  simShutdown: {
    input: z.object({ platform: SimPlatformZ, id: SimIdZ }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  /** One frame as a downscaled JPEG (base64). mac: the window of the app whose name matches `match`. */
  simFrame: {
    input: z.object({ platform: SimPlatformZ, id: SimIdZ, match: z.string().max(120).optional() }),
    output: z.object({ data: z.string().nullable(), mime: z.string(), error: z.string().nullable() }),
  },
  /** x/y are 0..1 of the screen. */
  simInput: {
    input: z.object({
      platform: SimPlatformZ,
      id: SimIdZ,
      action: z.enum(["tap", "swipe", "text", "key", "appearance", "textSize", "url"]),
      x: z.number().min(0).max(1).optional(),
      y: z.number().min(0).max(1).optional(),
      x2: z.number().min(0).max(1).optional(),
      y2: z.number().min(0).max(1).optional(),
      text: z.string().max(500).optional(),
      key: z.enum(["back", "home", "recents", "enter", "delete"]).optional(),
      value: z.string().max(40).optional(),
    }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  /** Newest app builds under the given folders (and Xcode's DerivedData for the given names). */
  simBuilds: {
    input: z.object({ platform: SimPlatformZ, roots: z.array(z.string().min(1).max(1000)).max(40), names: z.array(z.string().min(1).max(80)).max(4) }),
    output: z.object({ builds: z.array(z.object({ path: z.string(), mtime: z.number(), kind: z.enum(["app", "apk", "image"]) })) }),
  },
  /** Install and launch a build that simBuilds returned. */
  simInstall: {
    input: z.object({ platform: SimPlatformZ, id: SimIdZ, path: z.string().min(1).max(1500) }),
    output: z.object({ ok: z.boolean(), message: z.string(), match: z.string().nullable() }),
  },
  /** An image file (screenshot evidence) as base64, png/jpg/gif/webp only. */
  simImage: {
    input: z.object({ path: z.string().min(1).max(1500) }),
    output: z.object({ data: z.string().nullable(), mime: z.string() }),
  },
});

export type HostContract = typeof HOST_CONTRACT;
type In<M extends keyof HostContract> = z.input<HostContract[M]["input"]>;
type Out<M extends keyof HostContract> = z.output<HostContract[M]["output"]>;

/** What the engine sees: one async function per host method, already bound to a host. */
export type HostOps = { [M in keyof HostContract]: (input: In<M>) => Promise<Out<M>> };
export type ScanOutput = Out<"scan">;
export type ProbeOutput = Out<"probe">;
