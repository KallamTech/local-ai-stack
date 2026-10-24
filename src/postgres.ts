import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { promisify } from 'node:util';
import { consoleLogger, EXE, type Logger } from './log.js';
import { applySchema, assertIdent, ensureDatabase, schemaFingerprint, type SchemaOptions } from './migrate.js';
import { LOOPBACK, waitForPort } from './net.js';

const execFileAsync = promisify(execFile);

export interface PostgresOptions {
  /** Directory holding `postgres`, `initdb`, `pg_ctl`. */
  binDir: string;
  /** Cluster data directory; created and initdb'd on first run. */
  dataDir: string;
  /** App database, created if missing. */
  database: string;
  /** Default 54332 — away from 5432 and Supabase's 54322 so a dev stack doesn't collide. */
  port?: number;
  /** Cluster superuser created by initdb. Default `postgres`. */
  superuser?: string;
  /** Superuser password: the cluster uses scram-sha-256 for every connection.
   *  Keep it per install (e.g. Electron safeStorage). An existing trust-auth
   *  cluster is converted on first start with a password, and a lost password
   *  is reset in single-user mode. Required unless `trust` is set. */
  password?: string;
  /** Passwordless trust auth. Any local process — including other OS users on
   *  the machine — connects as superuser. Only for tests and throwaway data. */
  trust?: boolean;
  /** Unix socket dir. Default `/tmp` (data dirs under userData are too deep
   *  for the 103-byte socket path limit). `null` disables unix sockets.
   *  Ignored on Windows. */
  socketDir?: string | null;
  /** Extra server GUCs, e.g. `{ wal_level: 'logical' }` for logical decoding. */
  settings?: Record<string, string>;
  /** Applied on first run and whenever its fingerprint changes. */
  schema?: SchemaOptions;
  log?: Logger;
}

export interface PostgresEndpoint {
  port: number;
  dataDir: string;
  database: string;
  /** DSN for `role` (default superuser, with its password) on the app database. */
  url: (role?: string, password?: string) => string;
  /** ALTER ROLE … PASSWORD, e.g. for the login role PostgREST connects as. */
  setPassword: (role: string, password: string) => Promise<void>;
  /** This launch (re)applied the schema — dependents that cache it
   *  (PostgREST builds its schema cache at startup) must refresh. */
  schemaChanged: boolean;
  /** Whether this launch ran initdb. */
  initialized: boolean;
  stop: () => Promise<void>;
}

export function pgBin(binDir: string, name: string): string {
  return path.join(binDir, `${name}${EXE}`);
}

export function initdbArgs(dataDir: string, superuser: string, pwfile: string | null): string[] {
  const base = ['-D', dataDir, '-U', superuser, '--no-locale', '-E', 'UTF8'];
  return pwfile ? [...base, '-A', 'scram-sha-256', `--pwfile=${pwfile}`] : [...base, '-A', 'trust'];
}

/** pg_hba.conf with every `trust` rule switched to scram-sha-256. */
export function secureHba(conf: string): { conf: string; changed: boolean } {
  let changed = false;
  const out = conf
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line) || !/\btrust\s*$/.test(line)) return line;
      changed = true;
      return line.replace(/\btrust(\s*)$/, 'scram-sha-256$1');
    })
    .join('\n');
  return { conf: out, changed };
}

/** Escaped single-quoted SQL literal. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const UNSAFE_OPT = /[\s'"\\;$`|&<>()]/;

export function serverOptions(
  port: number,
  socketDir: string | null,
  settings: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): string {
  const parts = [`-p ${port}`, `-c listen_addresses=${LOOPBACK}`];
  // Windows Postgres has no unix sockets. 0700: the socket in a shared dir
  // like /tmp is still owner-only.
  if (platform !== 'win32') {
    if (socketDir && UNSAFE_OPT.test(socketDir)) throw new Error(`unsafe socketDir: ${socketDir}`);
    parts.push(`-c unix_socket_directories=${socketDir ?? "''"}`, '-c unix_socket_permissions=0700');
  }
  for (const [k, v] of Object.entries(settings)) {
    if (!/^[a-z_.]+$/i.test(k) || UNSAFE_OPT.test(v)) throw new Error(`unsafe setting ${k}=${v}`);
    parts.push(`-c ${k}=${v}`);
  }
  return parts.join(' ');
}

export function pgCtlStartArgs(dataDir: string, options: string): string[] {
  // -l is required: without it the detached postmaster inherits pg_ctl's stdio
  // pipes and holds them open, so execFile never sees EOF and waits out its
  // whole timeout on every launch.
  return ['-D', dataDir, '-l', path.join(dataDir, 'startup.log'), '-o', options, '-w', '-t', '60', 'start'];
}

async function pgCtlStop(binDir: string, dataDir: string): Promise<void> {
  await execFileAsync(pgBin(binDir, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], {
    timeout: 90_000,
  });
}

// A force-quit app leaves its detached postmaster running, and the next launch
// fails with "another server might be running". Stop it if pg_ctl sees it,
// otherwise drop a stale postmaster.pid.
async function clearStale(binDir: string, dataDir: string, log: Logger): Promise<void> {
  let running = false;
  try {
    await execFileAsync(pgBin(binDir, 'pg_ctl'), ['status', '-D', dataDir]);
    running = true;
  } catch {
    running = false;
  }
  if (running) {
    log('info', 'postgres', `stopping orphaned server on ${dataDir}`);
    await pgCtlStop(binDir, dataDir);
    return;
  }
  const pidFile = path.join(dataDir, 'postmaster.pid');
  if (existsSync(pidFile)) {
    log('info', 'postgres', 'removing stale postmaster.pid');
    await rm(pidFile, { force: true });
  }
}

// Single-user mode needs no authentication and no running server: the way
// back in when the cluster's password is unknown (trust → scram conversion,
// or a lost per-install secret). The password goes over stdin, never argv.
async function resetPasswordSingleUser(binDir: string, dataDir: string, role: string, password: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pgBin(binDir, 'postgres'), ['--single', '-D', dataDir, 'postgres'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 && !/ERROR/.test(err) ? resolve() : reject(new Error(`password reset failed: ${err.trim()}`)),
    );
    child.stdin.end(`ALTER ROLE "${assertIdent(role, 'role')}" PASSWORD ${sqlLiteral(password)}\n`);
  });
}

async function writePwfile(password: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sidecars-pw-'));
  const file = path.join(dir, 'pw');
  await writeFile(file, `${password}\n`, { mode: 0o600 });
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function isAuthFailure(e: unknown): boolean {
  return (e as { code?: string })?.code === '28P01';
}

export async function startPostgres(opts: PostgresOptions): Promise<PostgresEndpoint> {
  const {
    binDir,
    dataDir,
    database,
    port = 54332,
    superuser = 'postgres',
    socketDir = '/tmp',
    settings = {},
    log = consoleLogger,
    password,
    trust = false,
  } = opts;

  if (!password && !trust) {
    throw new Error('startPostgres: pass `password` (scram-sha-256) or opt in to `trust: true`.');
  }
  if (password && trust) throw new Error('startPostgres: `password` and `trust` are exclusive.');
  if (!existsSync(pgBin(binDir, 'postgres'))) {
    throw new Error(`Postgres not found at ${pgBin(binDir, 'postgres')}.`);
  }

  const dsn = (role: string, db: string, pw?: string) => {
    const auth = pw ? `${encodeURIComponent(role)}:${encodeURIComponent(pw)}` : encodeURIComponent(role);
    return `postgresql://${auth}@${LOOPBACK}:${port}/${db}`;
  };
  const url = (role = superuser, db = database, pw?: string) =>
    dsn(role, db, pw ?? (role === superuser ? password : undefined));
  const startServer = () =>
    execFileAsync(pgBin(binDir, 'pg_ctl'), pgCtlStartArgs(dataDir, serverOptions(port, socketDir, settings)), {
      timeout: 90_000,
    });
  const stop = async () => {
    try {
      await pgCtlStop(binDir, dataDir);
    } catch (e) {
      log('error', 'postgres', `stop failed: ${e}`);
    }
  };

  const initialized = !existsSync(path.join(dataDir, 'PG_VERSION'));
  if (initialized) {
    log('info', 'postgres', `initializing cluster at ${dataDir}`);
    await mkdir(dataDir, { recursive: true });
    const pw = password ? await writePwfile(password) : null;
    try {
      await execFileAsync(pgBin(binDir, 'initdb'), initdbArgs(dataDir, superuser, pw?.file ?? null), {
        timeout: 120_000,
      });
    } finally {
      await pw?.cleanup();
    }
  } else {
    await clearStale(binDir, dataDir, log);
    if (password) {
      const hbaPath = path.join(dataDir, 'pg_hba.conf');
      const hba = secureHba(await readFile(hbaPath, 'utf8'));
      if (hba.changed) {
        log('info', 'postgres', 'converting trust auth to scram-sha-256');
        await resetPasswordSingleUser(binDir, dataDir, superuser, password);
        await writeFile(hbaPath, hba.conf);
      }
    }
  }

  // pg_ctl -l appends; only the current boot matters.
  await rm(path.join(dataDir, 'startup.log'), { force: true });
  await startServer();

  let schemaChanged = false;
  // pg_ctl started a detached postmaster: if anything below throws before the
  // caller holds the endpoint, nobody would stop it and the next launch would
  // trip over it. Stop it here so failures are self-clearing.
  try {
    await waitForPort(port, 30_000, { label: 'postgres' });
    let created: boolean;
    try {
      created = await ensureDatabase(url(superuser, 'postgres'), database);
    } catch (e) {
      if (!password || !isAuthFailure(e)) throw e;
      // The stored secret no longer matches the cluster (e.g. a reset keychain).
      log('warn', 'postgres', 'password rejected — resetting it in single-user mode');
      await pgCtlStop(binDir, dataDir);
      await resetPasswordSingleUser(binDir, dataDir, superuser, password);
      await startServer();
      await waitForPort(port, 30_000, { label: 'postgres' });
      created = await ensureDatabase(url(superuser, 'postgres'), database);
    }
    if (opts.schema) {
      const stampPath = path.join(dataDir, '.sidecars-schema-version');
      const version = await schemaFingerprint(opts.schema);
      const applied = existsSync(stampPath) ? (await readFile(stampPath, 'utf8')).trim() : '';
      if (created || applied !== version) {
        log('info', 'postgres', `applying schema (${version})`);
        const n = await applySchema(url(), opts.schema, (m) => log('info', 'migrate', m));
        log('info', 'migrate', `done: ${n} migrations applied`);
        await writeFile(stampPath, version);
        schemaChanged = true;
      }
    }
  } catch (e) {
    await stop();
    throw e;
  }

  const setPassword = async (role: string, pw: string) => {
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    try {
      await client.query(`ALTER ROLE "${assertIdent(role, 'role')}" PASSWORD ${sqlLiteral(pw)}`);
    } finally {
      await client.end();
    }
  };

  log('info', 'postgres', `ready at ${dsn(superuser, database)}`);
  return {
    port,
    dataDir,
    database,
    url: (role, pw) => url(role, database, pw),
    setPassword,
    schemaChanged,
    initialized,
    stop,
  };
}
