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
  /**
   * The app's one work worktree: `path` checked out on `branch` (created from `base` when it does
   * not exist). Idempotent; refuses when the branch is checked out in another worktree.
   */
  ensureWorktree: {
    input: z.object({ repo: z.string().min(1).max(1000), path: z.string().min(1).max(1000), branch: z.string().min(1).max(200), base: z.string().min(1).max(300) }),
    output: z.object({ path: z.string(), branch: z.string(), head: z.string().nullable(), created: z.boolean() }),
  },
  /** Every worktree of a repository (the main checkout first); with `status`, each one's uncommitted-change count. */
  worktrees: {
    input: z.object({ repo: z.string().min(1).max(1000), status: z.boolean().optional() }),
    output: z.object({
      worktrees: z.array(z.object({ path: z.string(), branch: z.string().nullable(), head: z.string().nullable(), main: z.boolean(), dirty: z.number(), missing: z.boolean() })),
      /** Every local branch (at most 300). */
      branches: z.array(z.string()).optional(),
    }),
  },
  /** The Worktrees view: each folder's size on disk (with `measure`), its disk's free and total space, and each repository's shared git storage. */
  diskUsage: {
    input: z.object({ paths: z.array(z.string().min(1).max(1000)).max(80), repos: z.array(z.string().min(1).max(1000)).max(40).optional(), measure: z.boolean().optional() }),
    output: z.object({
      sizes: z.array(z.object({ path: z.string(), bytes: z.number().nullable(), dev: z.number().nullable(), free: z.number().nullable(), total: z.number().nullable() })),
      repos: z.array(z.object({ repo: z.string(), gitDir: z.string().nullable(), bytes: z.number().nullable() })),
    }),
  },
  /** Show a folder in the file manager (Finder, Explorer, the Files app); a folder that is gone opens its nearest parent. */
  reveal: {
    input: z.object({ path: z.string().min(1).max(1000) }),
    output: z.object({ ok: z.boolean(), shown: z.string().nullable() }),
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
  /** Which external tools (Blender, Unreal, Docker…) are installed: a binary on PATH or an app bundle path (one `*` per path). */
  toolProbe: {
    input: z.object({
      tools: z.array(z.object({ id: z.string().max(60), bins: z.array(z.string().regex(/^[\w.+-]+$/).max(60)).max(6), paths: z.array(z.string().max(300)).max(6).default([]) })).max(24),
    }),
    output: z.object({ found: z.record(z.string(), z.string().nullable()) }),
  },
  // ── Screens view (the human clicks through an app's committed screenshots) ──
  /** Screenshots under each folder's reports/, screens/ or screenshots/ folders (with their pixel size), and each folder's reports/screens/screens.json. */
  screensScan: {
    input: z.object({ roots: z.array(z.string().min(1).max(1000)).max(40) }),
    output: z.object({ files: z.array(z.object({ root: z.string(), rel: z.string(), mtime: z.number(), w: z.number().nullable().optional(), h: z.number().nullable().optional() })), maps: z.array(z.object({ root: z.string(), text: z.string(), mtime: z.number() })) }),
  },
  /** An image file as base64, png/jpg/gif/webp only. */
  screenImage: {
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
