import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { consoleLogger, pipeOutput, type Logger } from './log.js';
import { findListenerPid, isPortOpen, killPid, LOOPBACK, waitForPort } from './net.js';

export type RedisFlavor = 'redis' | 'garnet';

export interface RedisOptions {
  /** `redis-server`, or Microsoft Garnet's `GarnetServer.exe` on Windows
   *  (Redis has no native Windows server; Garnet speaks RESP). */
  bin: string;
  /** Persistence directory (append-only log), created if missing. */
  dataDir: string;
  /** Default 6399 — away from 6379 so a user's own Redis doesn't collide. */
  port?: number;
  /** Default: `garnet` when the binary name contains "garnet", else `redis`. */
  flavor?: RedisFlavor;
  /** requirepass. Strongly recommended: without it any local process can read
   *  and write your queues. A fresh random value per launch is fine — an
   *  instance left over from an earlier launch is then replaced. Passed over
   *  stdin for Redis (never argv, which `ps` shows); Garnet only takes argv. */
  password?: string;
  /** Reuse an instance already on the port — only if it accepts `password`
   *  (or, without a password, answers PING). A Redis that rejects the
   *  credentials is replaced; anything else on the port is an error. Default true. */
  reuseExisting?: boolean;
  log?: Logger;
}

export interface RedisEndpoint {
  host: string;
  port: number;
  password: string | null;
  /** `redis://[:password@]127.0.0.1:port` */
  url: string;
  child: ChildProcess | null;
  adoptedPid: number | null;
  stop: () => void;
}

export function detectFlavor(bin: string): RedisFlavor {
  return /garnet/i.test(path.basename(bin)) ? 'garnet' : 'redis';
}

// Same intent for both: loopback on our port, append-only log so queued jobs
// survive a crash, no RDB snapshots. Garnet spells the flags differently.
// With a password, Redis reads `requirepass` from stdin (the leading `-`).
export function redisServerArgs(flavor: RedisFlavor, port: number, dataDir: string, password?: string): string[] {
  if (flavor === 'garnet') {
    return [
      '--port', String(port),
      '--bind', LOOPBACK,
      '--logdir', dataDir,
      '--checkpointdir', dataDir,
      '--aof',
      '--recover',
      ...(password ? ['--auth', 'Password', '--password', password] : []),
    ];
  }
  return [
    ...(password ? ['-'] : []),
    '--port', String(port),
    '--bind', LOOPBACK,
    '--dir', dataDir,
    '--appendonly', 'yes',
    '--save', '',
  ];
}

export function redisConfig(password: string): string {
  if (/[\s"'\\]/.test(password)) throw new Error('redis password must not contain whitespace, quotes or backslashes');
  return `requirepass ${password}\n`;
}

function resp(...args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
}

/** `accepted`: PONG with our credentials. `rejected`: a Redis that refused them
 *  (NOAUTH / WRONGPASS / AUTH without requirepass). `unknown`: anything else
 *  on the port, or no RESP reply in time. */
export type RedisProbe = 'accepted' | 'rejected' | 'unknown';

export function probeRedis(port: number, password?: string, timeoutMs = 1500): Promise<RedisProbe> {
  return new Promise((resolve) => {
    const s = net.connect(port, LOOPBACK);
    let buf = '';
    let settled = false;
    const done = (result: RedisProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      s.destroy();
      resolve(result);
    };
    const t = setTimeout(() => done('unknown'), timeoutMs);
    s.once('connect', () => s.write((password ? resp('AUTH', password) : '') + resp('PING')));
    s.on('data', (d) => {
      buf += d.toString();
      if (!buf.includes('\r\n')) return;
      const first = buf.slice(0, buf.indexOf('\r\n'));
      if (/^-(NOAUTH|WRONGPASS|ERR AUTH)\b/.test(first)) done('rejected');
      else if (buf.includes('+PONG\r\n')) done('accepted');
      else if (!/^\+OK$/.test(first)) done('unknown');
    });
    s.once('error', () => done('unknown'));
  });
}

/** True when the instance on `port` accepts `password` (or PING without one). */
export async function redisAccepts(port: number, password?: string, timeoutMs = 1500): Promise<boolean> {
  return (await probeRedis(port, password, timeoutMs)) === 'accepted';
}

export async function startRedis(opts: RedisOptions): Promise<RedisEndpoint> {
  const port = opts.port ?? 6399;
  const log = opts.log ?? consoleLogger;
  const password = opts.password ?? null;
  if (password) redisConfig(password);
  const url = password
    ? `redis://:${encodeURIComponent(password)}@${LOOPBACK}:${port}`
    : `redis://${LOOPBACK}:${port}`;
  const endpoint = (child: ChildProcess | null, adoptedPid: number | null): RedisEndpoint => ({
    host: LOOPBACK,
    port,
    password,
    url,
    child,
    adoptedPid,
    stop: () => {
      if (child && !child.killed) child.kill();
      else killPid(adoptedPid);
    },
  });

  if (await isPortOpen(port)) {
    if (opts.reuseExisting === false) throw new Error(`Port ${port} is already in use.`);
    const pid = await findListenerPid(port);
    const probe = await probeRedis(port, password ?? undefined);
    if (probe === 'accepted') {
      log('info', 'redis', `reusing instance already on ${port} (pid=${pid ?? '?'})`);
      return endpoint(null, pid);
    }
    if (probe === 'unknown') {
      throw new Error(`Port ${port} is held by a process that does not answer as Redis (pid ${pid ?? '?'}).`);
    }
    // Typically our own instance from an earlier launch, with another password.
    if (!pid) throw new Error(`Port ${port} is held by a Redis that rejects our credentials.`);
    log('warn', 'redis', `replacing instance on ${port} that rejects our credentials (pid=${pid})`);
    killPid(pid);
    for (let i = 0; i < 25 && (await isPortOpen(port)); i += 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!existsSync(opts.bin)) throw new Error(`Redis server not found at ${opts.bin}.`);
  await mkdir(opts.dataDir, { recursive: true });

  const flavor = opts.flavor ?? detectFlavor(opts.bin);
  const viaStdin = Boolean(password) && flavor === 'redis';
  const child = spawn(opts.bin, redisServerArgs(flavor, port, opts.dataDir, password ?? undefined), {
    stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (viaStdin) child.stdin?.end(redisConfig(password!));
  pipeOutput(child, 'redis');
  child.on('exit', (code) => log('error', 'redis', `exited with code ${code}`));

  try {
    await waitForPort(port, 15_000, { pollIntervalMs: 150, label: 'Redis' });
  } catch (e) {
    child.kill();
    throw e;
  }
  log('info', 'redis', `ready on ${LOOPBACK}:${port}`);
  return endpoint(child, null);
}
