import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

export const LOOPBACK = '127.0.0.1';

/** True when a TCP connect() to 127.0.0.1:port succeeds within `timeoutMs`.
 *  Never throws. The timeout matters: a filtered SYN can otherwise hang. */
export function isPortOpen(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = net.connect(port, LOOPBACK);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => {
      clearTimeout(t);
      done(true);
    });
    s.once('error', () => {
      clearTimeout(t);
      done(false);
    });
  });
}

/** Rejects with a message naming the service when nothing binds in time. */
export async function waitForPort(
  port: number,
  timeoutMs: number,
  { pollIntervalMs = 500, label }: { pollIntervalMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port, Math.min(1500, pollIntervalMs * 2))) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  const svc = label ? `${label} ` : '';
  throw new Error(
    `${svc}did not bind to ${LOOPBACK}:${port} within ${Math.round(timeoutMs / 1000)}s`,
  );
}

/** An OS-assigned free loopback port. Racy by nature: bind it soon. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, LOOPBACK, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** PID listening on `port` via lsof (macOS/Linux); null when unknown. */
export function findListenerPid(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']);
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.on('close', () => {
      const pid = parseInt(out.trim().split('\n')[0], 10);
      resolve(Number.isFinite(pid) ? pid : null);
    });
    p.on('error', () => resolve(null));
  });
}

/** True when `pid` is alive and its executable's basename is `name` (macOS/Linux
 *  via `ps`; always false on Windows). Guards pidfile-based reaping against a
 *  recycled pid. */
export function isProcessNamed(pid: number, name: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
    return path.basename(comm) === name;
  } catch {
    return false;
  }
}

export function killPid(pid: number | null, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}
