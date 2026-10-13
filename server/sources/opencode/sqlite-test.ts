// Test helper: guarded access to `node:sqlite`.
//
// `node:sqlite` (DatabaseSync) ships with Node 22.13+ / 24+. On older Node the
// OpenCode tests cannot build fixture databases, so they skip instead of
// failing. The production code (files.ts) already degrades the same way at
// runtime.
import { createRequire } from 'node:module';
import { describe } from 'vitest';

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown };
  close(): void;
};
type DbCtor = new (path: string) => SqliteDb;

let impl: DbCtor | undefined;
try {
  impl = createRequire(import.meta.url)('node:sqlite').DatabaseSync as DbCtor;
} catch {
  impl = undefined;
}

/**
 * DatabaseSync constructor. Only usable inside `describeSqlite` blocks, which
 * are skipped when `node:sqlite` is unavailable.
 */
export const DatabaseSync = impl as DbCtor;

/** Instance type, for annotations in tests. */
export type DatabaseSync = SqliteDb;

/** `describe` that skips the whole block when `node:sqlite` is unavailable. */
export const describeSqlite = impl ? describe : describe.skip;
