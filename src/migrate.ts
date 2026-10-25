import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/**
 * psql-free schema bootstrap: prelude files → migrations (in filename order,
 * each applied once, tracked in a table) → postlude files. Prelude/postlude
 * run on every bootstrap, so write them idempotently.
 *
 * The prelude is where you make a bare Postgres look like whatever your
 * migrations expect (roles, schemas, extensions, stubs for hosted-only
 * objects) without editing the migrations themselves.
 */
export interface SchemaOptions {
  /** Directory of `*.sql` migrations, applied in sorted filename order. */
  migrationsDir?: string;
  /** Run before migrations, every bootstrap. */
  prelude?: string[];
  /** Run after migrations, every bootstrap. */
  postlude?: string[];
  /** `CREATE EXTENSION [IF NOT EXISTS] <name>` lines for these extensions are
   *  removed from migrations — for hosted-only extensions (e.g. pg_cron) your
   *  prelude stubs or your app doesn't need locally. */
  stripExtensions?: string[];
  /** search_path reset before each file. Default `public`. */
  searchPath?: string;
  /** Tracking table. Default `public.schema_migrations`. */
  trackingTable?: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const SEARCH_PATH = /^[\w$", ]+$/;

export function assertIdent(name: string, what = 'identifier'): string {
  if (!IDENT.test(name)) throw new Error(`unsafe ${what}: ${name}`);
  return name;
}

export function stripExtensionLines(sql: string, extensions: string[]): string {
  if (!extensions.length) return sql;
  const names = extensions.map((e) => e.replace(/[^A-Za-z0-9_-]/g, '')).join('|');
  const re = new RegExp(
    `^[ \\t]*CREATE EXTENSION (IF NOT EXISTS )?"?(${names})"?\\b.*$`,
    'gim',
  );
  return sql.replace(re, '');
}

export async function ensureDatabase(adminUri: string, dbName: string): Promise<boolean> {
  assertIdent(dbName, 'database name');
  const client = new pg.Client({ connectionString: adminUri });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
    if (rows.length) return false;
    await client.query(`CREATE DATABASE "${dbName}"`);
    return true;
  } finally {
    await client.end();
  }
}

/** Returns the number of migrations recorded as applied. */
export async function applySchema(
  dbUri: string,
  opts: SchemaOptions,
  log: (msg: string) => void = () => {},
): Promise<number> {
  const searchPath = opts.searchPath ?? 'public';
  const table = opts.trackingTable ?? 'public.schema_migrations';
  if (!QUALIFIED.test(table)) throw new Error(`unsafe tracking table: ${table}`);
  if (!SEARCH_PATH.test(searchPath)) throw new Error(`unsafe search_path: ${searchPath}`);
  const client = new pg.Client({ connectionString: dbUri });
  await client.connect();
  try {
    // A file may set_config('search_path', '') mid-way (pg_dump output does),
    // which sticks on this reused connection and breaks every later file —
    // psql dodges it with a fresh connection per file; we reset instead.
    const run = async (sql: string) => {
      await client.query(`SET search_path TO ${searchPath}`);
      await client.query(sql);
    };

    for (const file of opts.prelude ?? []) {
      log(`prelude ${path.basename(file)}`);
      await run(readFileSync(file, 'utf8'));
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table}(version text PRIMARY KEY, applied_at timestamptz DEFAULT now())`,
    );

    if (opts.migrationsDir) {
      const files = (await readdir(opts.migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files) {
        const seen = await client.query(`SELECT 1 FROM ${table} WHERE version=$1`, [f]);
        if (seen.rows.length) continue;
        log(f);
        const sql = stripExtensionLines(
          readFileSync(path.join(opts.migrationsDir, f), 'utf8'),
          opts.stripExtensions ?? [],
        );
        // One multi-statement query per file. Not safe for CREATE INDEX
        // CONCURRENTLY, which can't run inside the implicit transaction.
        await run(sql);
        await client.query(`INSERT INTO ${table}(version) VALUES ($1)`, [f]);
      }
    }

    for (const file of opts.postlude ?? []) {
      log(`postlude ${path.basename(file)}`);
      await run(readFileSync(file, 'utf8'));
    }

    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0].n as number;
  } finally {
    await client.end();
  }
}

/** Cheap fingerprint of the schema inputs: newest migration filename plus a
 *  hash of prelude/postlude contents. Editing a prelude adds no migration
 *  file, so without the hash an existing data dir would never pick it up. */
export async function schemaFingerprint(opts: SchemaOptions): Promise<string> {
  let newest = 'none';
  if (opts.migrationsDir) {
    const files = (await readdir(opts.migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    newest = files[files.length - 1] ?? 'none';
  }
  const hash = createHash('sha256');
  for (const f of [...(opts.prelude ?? []), ...(opts.postlude ?? [])]) {
    // Basename, not full path: the app bundle moving must not force a re-bootstrap.
    hash.update(path.basename(f));
    if (existsSync(f)) hash.update(await readFile(f));
  }
  hash.update(JSON.stringify(opts.stripExtensions ?? []));
  return `${newest}+${hash.digest('hex').slice(0, 12)}`;
}
