import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { consoleLogger, pipeOutput, type Logger } from './log.js';
import { findListenerPid, isPortOpen, isProcessNamed, killPid, LOOPBACK, waitForPort } from './net.js';

export interface PostgrestOptions {
  /** Path to the `postgrest` binary. */
  bin: string;
  /** DSN of the login role PostgREST connects as (e.g. `authenticator`). */
  dbUri: string;
  /** Role used for requests without a JWT. */
  anonRole: string;
  /** Default 3001. Ignored with `unixSocket`. */
  port?: number;
  /** Serve on this unix socket (mode 600, parent dir forced to 0700) instead
   *  of TCP: only this OS user can reach it, and browsers can't at all. Put it
   *  in a short path (sockets are limited to ~103 bytes). Not on Windows. */
  unixSocket?: string;
  /** PGRST_SERVER_CORS_ALLOWED_ORIGINS. Without it PostgREST reflects any
   *  request Origin — any web page can read a TCP listener's responses. */
  corsAllowedOrigins?: string[];
  /** Default `['public']`. */
  schemas?: string[];
  /** Include the schema your extensions live in, or e.g. pgvector's `vector`
   *  type won't resolve in RPCs. Default `['public']`. */
  extraSearchPath?: string[];
  /** Enables JWT auth (PGRST_JWT_SECRET). Required unless `allowAnonymous`. */
  jwtSecret?: string;
  /** Run without a JWT secret, so every request is `anonRole`. Only safe when
   *  nothing untrusted can reach the server — pair it with `unixSocket` behind
   *  your own authenticating proxy. */
  allowAnonymous?: boolean;
  /** Directory with libpq for dynamically linked builds (macOS): set as
   *  DYLD_FALLBACK_LIBRARY_PATH. Hardened-runtime apps ignore DYLD_* — rewrite
   *  the install name instead (see scripts/build-bin.sh). */
  libDir?: string;
  /** Reuse a PostgREST already listening on `port` (TCP only). Default false:
   *  any local process can hold the port and answer as PostgREST, and an
   *  adopted one receives this app's database traffic. Turn it on only when
   *  the instance on the port is known to be yours (e.g. an earlier launch). */
  adoptExisting?: boolean;
  /** PostgREST builds its schema cache once at startup: pass the Postgres
   *  endpoint's `schemaChanged` so an adopted instance is restarted. */
  schemaChanged?: boolean;
  logLevel?: 'crit' | 'error' | 'warn' | 'info' | 'debug';
  /** Extra PGRST_* (or other) env for the child. */
  env?: Record<string, string>;
  log?: Logger;
}

export interface PostgrestEndpoint {
  /** Base URL. With `unixSocket` the host part is a placeholder: send requests
   *  with `socketPath` (Node http) instead. */
  url: string;
  port: number | null;
  socketPath: string | null;
  child: ChildProcess | null;
  /** Set when an already-running PostgREST on the port was reused. */
  adoptedPid: number | null;
  stop: () => void;
}

export function postgrestEnv(
  opts: PostgrestOptions,
  port: number,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!opts.jwtSecret && !opts.allowAnonymous) {
    throw new Error('startPostgrest: pass `jwtSecret`, or `allowAnonymous: true` behind a trusted proxy.');
  }
  const env: NodeJS.ProcessEnv = {
    ...base,
    PGRST_DB_URI: opts.dbUri,
    PGRST_DB_SCHEMAS: (opts.schemas ?? ['public']).join(','),
    PGRST_DB_ANON_ROLE: opts.anonRole,
    PGRST_DB_EXTRA_SEARCH_PATH: (opts.extraSearchPath ?? ['public']).join(', '),
    PGRST_LOG_LEVEL: opts.logLevel ?? 'error',
    ...opts.env,
  };
  if (opts.unixSocket) {
    env.PGRST_SERVER_UNIX_SOCKET = opts.unixSocket;
    env.PGRST_SERVER_UNIX_SOCKET_MODE = '600';
  } else {
    env.PGRST_SERVER_HOST = LOOPBACK;
    env.PGRST_SERVER_PORT = String(port);
  }
  if (opts.corsAllowedOrigins?.length) {
    env.PGRST_SERVER_CORS_ALLOWED_ORIGINS = opts.corsAllowedOrigins.join(',');
  }
  if (opts.jwtSecret) env.PGRST_JWT_SECRET = opts.jwtSecret;
  if (opts.libDir) env.DYLD_FALLBACK_LIBRARY_PATH = opts.libDir;
  return env;
}

// PostgREST sets `Server: postgrest/<version>` on every response, errors
// included — check it before adopting a listener so DB traffic never goes to
// an unrelated process that grabbed the port.
export function isPostgrest(url: string, socketPath?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${url}/`, { timeout: 1500, socketPath }, (res) => {
      res.resume();
      resolve(/postgrest/i.test(String(res.headers['server'] ?? '')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function rootStatus(url: string, socketPath?: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(`${url}/`, { timeout: 1500, socketPath }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
  });
}

// PostgREST binds before its schema cache loads and answers 503 (PGRST002)
// until then — a bound port is not "ready".
async function waitForSchemaCache(url: string, timeoutMs: number, socketPath?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await rootStatus(url, socketPath);
    if (status > 0 && status < 500) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`PostgREST did not load its schema cache within ${Math.round(timeoutMs / 1000)}s`);
}

// Socket mode never adopts: a pidfile next to the socket identifies a
// leftover instance from a crashed launch, which is stopped and replaced.
async function startOnSocket(opts: PostgrestOptions, socketPath: string, log: Logger): Promise<PostgrestEndpoint> {
  if (process.platform === 'win32') throw new Error('startPostgrest: unixSocket is not supported on Windows.');
  const dir = path.dirname(socketPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const pidFile = `${socketPath}.pid`;
  if (existsSync(pidFile)) {
    const stale = parseInt(readFileSync(pidFile, 'utf8'), 10);
    if (Number.isFinite(stale) && isProcessNamed(stale, path.basename(opts.bin))) {
      log('warn', 'postgrest', `stopping leftover instance (pid=${stale})`);
      killPid(stale);
    }
  }
  await rm(socketPath, { force: true });

  const url = 'http://localhost';
  const child = spawn(opts.bin, [], { env: postgrestEnv(opts, 0), stdio: ['ignore', 'pipe', 'pipe'] });
  pipeOutput(child, 'postgrest');
  child.on('exit', (code) => log('error', 'postgrest', `exited with code ${code}`));
  if (child.pid) await writeFile(pidFile, String(child.pid), { mode: 0o600 });

  try {
    await waitForSchemaCache(url, 30_000, socketPath);
  } catch (e) {
    child.kill();
    throw e;
  }
  log('info', 'postgrest', `ready on ${socketPath}`);
  return {
    url,
    port: null,
    socketPath,
    child,
    adoptedPid: null,
    stop: () => {
      if (!child.killed) child.kill();
      void rm(pidFile, { force: true });
    },
  };
}

export async function startPostgrest(opts: PostgrestOptions): Promise<PostgrestEndpoint> {
  const log = opts.log ?? consoleLogger;
  postgrestEnv(opts, 0, {}); // validates auth options before anything is adopted or spawned
  if (!existsSync(opts.bin)) throw new Error(`PostgREST binary not found at ${opts.bin}.`);
  if (opts.unixSocket) return startOnSocket(opts, opts.unixSocket, log);

  const port = opts.port ?? 3001;
  const url = `http://${LOOPBACK}:${port}`;
  const endpoint = (child: ChildProcess | null, adoptedPid: number | null): PostgrestEndpoint => ({
    url,
    port,
    socketPath: null,
    child,
    adoptedPid,
    stop: () => {
      if (child && !child.killed) child.kill();
      else killPid(adoptedPid);
    },
  });

  if (await isPortOpen(port)) {
    if (!(await isPostgrest(url))) {
      const pid = await findListenerPid(port);
      throw new Error(`Port ${port} is held by a non-PostgREST process (pid ${pid ?? '?'}).`);
    }
    const existingPid = await findListenerPid(port);
    if (!opts.adoptExisting) {
      throw new Error(
        `Port ${port} already has a PostgREST instance (pid ${existingPid ?? '?'}); pass adoptExisting: true to reuse it, or use unixSocket.`,
      );
    }
    if (!(opts.schemaChanged && existingPid)) {
      log('warn', 'postgrest', `reusing existing instance at ${url} (pid=${existingPid ?? '?'})`);
      return endpoint(null, existingPid);
    }
    // An adopted instance would keep serving its stale schema cache (new
    // tables 404 until restart), so replace it.
    log('warn', 'postgrest', `schema changed — restarting existing instance (pid=${existingPid})`);
    killPid(existingPid);
    for (let i = 0; i < 25 && (await isPortOpen(port)); i += 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const child = spawn(opts.bin, [], {
    env: postgrestEnv(opts, port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeOutput(child, 'postgrest');
  child.on('exit', (code) => log('error', 'postgrest', `exited with code ${code}`));

  try {
    await waitForPort(port, 30_000, { pollIntervalMs: 200, label: 'PostgREST' });
    await waitForSchemaCache(url, 30_000);
  } catch (e) {
    child.kill();
    throw e;
  }
  log('info', 'postgrest', `ready at ${url}`);
  return endpoint(child, null);
}
