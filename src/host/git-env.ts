// The environment every host git command runs with. Variables that point git at another
// repository, index or object store, or inject config, are dropped: the host daemon may have
// inherited them, and git must work on exactly the folder Helm names.

const DROP = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|EXTERNAL_DIFF|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;

export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROP.test(k)) out[k] = v;
  return { ...out, GIT_TERMINAL_PROMPT: "0", ...extra };
}

/** Config every host git command sets on its command line, so repository-local config (which agents can write) cannot run programs: no fsmonitor hook. */
export const SAFE_GIT_CONFIG = ["-c", "core.fsmonitor=false"];

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
