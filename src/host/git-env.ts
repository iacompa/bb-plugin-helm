// The environment every host git command runs with. Variables that point git at another
// repository, index or object store, or inject config, are dropped: the host daemon may have
// inherited them, and git must work on exactly the folder Helm names.

const DROP = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|EXTERNAL_DIFF|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;

export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROP.test(k)) out[k] = v;
  return { ...out, GIT_TERMINAL_PROMPT: "0", ...extra };
}

/**
 * Config every host git command sets on its command line, so a repository's own config (which
 * agents can write) cannot make Helm's git run a program: no fsmonitor, no hooks (only Helm's own
 * commands skip them; agents' commits still run them), no recursion into submodules, no signature
 * checks in log, and no signing (Helm's own commits are authored by Helm, not with your key).
 * Filter drivers need the repository's config read first: see filterOverrides.
 */
export const SAFE_GIT_CONFIG = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "submodule.recurse=false",
  "-c", "log.showSignature=false",
  "-c", "commit.gpgSign=false",
];

/** The query whose output filterOverrides reads (git 2.26 and later print each entry's scope). */
export const FILTER_QUERY = ["config", "-z", "--show-scope", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"];

/** The stock Git LFS filter commands, the one filter Helm lets a repository's own config run. */
const LFS = /^git-lfs (filter-process|smudge|clean)( --skip)?( -- %f)?$/;

/**
 * -c arguments that switch off every filter driver a repository's own config defines (smudge runs
 * on checkout, clean on status and add), except the stock Git LFS commands. Drivers from your
 * global or system config still run. `listing` is FILTER_QUERY's output; `scoped: false` (git
 * without --show-scope) treats every driver as the repository's. A driver name -c cannot carry
 * (with "=" or a line break) is an error, so the command does not run.
 */
export function filterOverrides(listing: string, scoped = true): string[] | { error: string } {
  const parts = listing.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const off = new Set<string>();
  for (let i = 0; i < parts.length; ) {
    const scope = scoped ? parts[i++] : "local";
    const entry = parts[i++] ?? "";
    const nl = entry.indexOf("\n");
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const value = nl < 0 ? "" : entry.slice(nl + 1);
    const m = key.match(/^filter\.([\s\S]+)\.(clean|smudge|process)$/);
    if (!m || (scope !== "local" && scope !== "worktree")) continue;
    if (!LFS.test(value.trim())) off.add(m[1]);
  }
  const args: string[] = [];
  for (const name of off) {
    if (/[=\n\0]/.test(name)) return { error: `this repository's git config defines a filter Helm cannot switch off ("${name.slice(0, 40)}"), so Helm will not run git there. Remove it with git config --unset.` };
    for (const k of ["process", "smudge", "clean"]) args.push("-c", `filter.${name}.${k}=`);
    args.push("-c", `filter.${name}.required=false`);
  }
  return args;
}

/** For commands that talk to a remote: only the usual transports (never ext::), and the stock upload-pack. */
export const SAFE_REMOTE_CONFIG = [
  ...SAFE_GIT_CONFIG,
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.http.allow=always",
  "-c", "protocol.ssh.allow=always",
  "-c", "protocol.git.allow=always",
  "-c", "protocol.file.allow=always",
  "-c", "protocol.ext.allow=never",
  "-c", "protocol.fd.allow=never",
];
