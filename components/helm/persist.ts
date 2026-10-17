// Panel state that survives leaving the panel, reloading, or opening Helm in another
// window: localStorage, JSON, never throws. Stored values are untrusted, so every
// reader checks the shape and falls back to the default.
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export function lsGet(k: string): string | null {
  try {
    return globalThis.localStorage?.getItem(k) ?? null;
  } catch {
    return null;
  }
}

export function lsSet(k: string, v: string | null) {
  try {
    if (v === null) globalThis.localStorage?.removeItem(k);
    else globalThis.localStorage?.setItem(k, v);
  } catch {
    /* storage unavailable or full: the panel still works, it just forgets */
  }
}

/** A stored JSON value, or `fallback` when missing, unreadable or rejected by `ok`. */
export function readStored<T>(key: string, fallback: T, ok: (v: unknown) => boolean = () => true): T {
  const raw = lsGet(key);
  if (raw === null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    return ok(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The default check: the stored value has the same kind as the default (anything goes for a null default). */
export function sameKind(init: unknown): (v: unknown) => boolean {
  if (init === null) return () => true;
  if (Array.isArray(init)) return (v) => Array.isArray(v);
  if (typeof init === "object") return (v) => !!v && typeof v === "object" && !Array.isArray(v);
  return (v) => typeof v === typeof init;
}

/** useState that is written to localStorage on every change and read back on mount. */
export function useStored<T>(key: string, initial: T | (() => T), ok?: (v: unknown) => boolean): [T, Dispatch<SetStateAction<T>>] {
  const [v, setV] = useState<T>(() => {
    const init = typeof initial === "function" ? (initial as () => T)() : initial;
    return readStored(key, init, ok ?? sameKind(init));
  });
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) =>
      setV((prev) => {
        const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        lsSet(key, value === undefined ? null : JSON.stringify(value));
        return value;
      }),
    [key],
  );
  return [v, set];
}

/** Forget every stored value whose key starts with `prefix`. */
export function clearStored(prefix: string) {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) ls.removeItem(k);
  } catch {
    /* storage unavailable */
  }
}
