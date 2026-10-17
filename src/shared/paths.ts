// Where Helm may put or adopt an app repository. Apps can live anywhere on the
// host the human names (another disk, an existing checkout), except the
// filesystem root, the home folder itself and operating-system folders.

const SYSTEM_PREFIXES = ["/System", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/dev", "/proc", "/sys", "/boot", "/Library", "/Applications", "/opt/homebrew", "/cores"];
const WINDOWS_SYSTEM = /^[A-Za-z]:[\\/](Windows|Program Files|Program Files \(x86\)|ProgramData)([\\/]|$)/i;

/** Expand a leading ~ against the host's home folder. */
export function expandTilde(p: string, home: string | null | undefined): string {
  const t = p.trim();
  if (!home) return t;
  if (t === "~") return home;
  if (t.startsWith("~/")) return `${home.replace(/\/+$/, "")}/${t.slice(2)}`;
  return t;
}

function norm(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return /^[A-Za-z]:/.test(p) ? parts.join("/") : `/${parts.join("/")}`;
}

/** null when Helm may use the folder; otherwise the reason it may not. */
export function targetPathProblem(raw: string, home: string | null | undefined): string | null {
  const p = expandTilde(raw, home);
  if (p.startsWith("~")) return `"${raw}" starts with ~ but the host's home folder is unknown; use an absolute path.`;
  if (!(p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p))) return `"${raw}" is not an absolute path (start it with / or ~/).`;
  const n = norm(p);
  if (n === "/" || /^[A-Za-z]:$/.test(n)) return `"${raw}" is the root of the disk; name a folder inside it.`;
  if (home && n === norm(home)) return `"${raw}" is your home folder; name a folder inside it.`;
  if (/^\/Volumes\/[^/]+$/.test(n)) return `"${raw}" is the top of a disk; name a folder on it (for example ${n}/apps/<name>).`;
  for (const pre of SYSTEM_PREFIXES) if (n === pre || n.startsWith(`${pre}/`)) return `"${raw}" is inside the system folder ${pre}; Helm never writes there.`;
  if (WINDOWS_SYSTEM.test(p)) return `"${raw}" is a Windows system folder; Helm never writes there.`;
  return null;
}

/** Normalized absolute form for comparing two folders (after ~ expansion). */
export function samePath(a: string, b: string, home: string | null | undefined): boolean {
  return norm(expandTilde(a, home)) === norm(expandTilde(b, home));
}

/** True when `inner` is `outer` or inside it. */
export function isInside(inner: string, outer: string, home: string | null | undefined): boolean {
  const i = norm(expandTilde(inner, home));
  const o = norm(expandTilde(outer, home));
  return i === o || i.startsWith(`${o}/`);
}
