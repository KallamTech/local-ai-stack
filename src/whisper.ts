import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { consoleLogger, pipeOutput, type Logger } from './log.js';
import { findFreePort, isProcessNamed, LOOPBACK } from './net.js';
import type { Progress } from './ollama.js';

/** A downloadable model pinned to exact size + sha256. */
export interface PinnedModel {
  file: string;
  url: string;
  size: number;
  sha256: string;
}

/** whisper.cpp large-v3-turbo, q5_0 — pinned to the Hugging Face LFS record. */
export const WHISPER_LARGE_V3_TURBO_Q5: PinnedModel = {
  file: 'ggml-large-v3-turbo-q5_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  size: 574_041_195,
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
};

interface VerifiedMarker {
  size: number;
  mtimeMs: number;
  ino: number;
  sha256: string;
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

const markerPath = (file: string) => `${file}.verified.json`;

export async function writeMarker(file: string, sha256: string): Promise<void> {
  const st = await stat(file);
  const marker: VerifiedMarker = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, sha256 };
  await writeFile(markerPath(file), JSON.stringify(marker), { mode: 0o600 });
}

/** The marker is trusted only while the file is the exact inode, size and
 *  mtime that was hashed; any replacement or in-place edit forces a re-hash. */
export async function markerMatches(file: string, sha256: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(markerPath(file), 'utf8')) as VerifiedMarker;
    const st = await stat(file);
    return (
      marker.sha256 === sha256 &&
      marker.size === st.size &&
      marker.mtimeMs === st.mtimeMs &&
      marker.ino === st.ino
    );
  } catch {
    return false;
  }
}

// Hugging Face /resolve redirects to its CDN; follow a bounded chain, https only.
function httpsGet(url: string, headers: Record<string, string>, redirectsLeft = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('https://')) {
      reject(new Error(`refusing non-https model URL: ${url}`));
      return;
    }
    const req = https.get(url, { headers, timeout: 30_000 }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('too many redirects downloading model'));
          return;
        }
        resolve(httpsGet(new URL(location, url).toString(), headers, redirectsLeft - 1));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function download(model: PinnedModel, partFile: string, onProgress: Progress, label: string) {
  const have = await fileSize(partFile);
  const res = await httpsGet(
    model.url,
    have > 0 && have < model.size ? { Range: `bytes=${have}-` } : {},
  );
  const status = res.statusCode ?? 0;
  if (status !== 200 && status !== 206) {
    res.resume();
    throw new Error(`model download failed: HTTP ${status}`);
  }
  // A server that ignores Range replies 200 with the whole file — restart.
  const resumed = status === 206;
  let done = resumed ? have : 0;
  let lastReported = -1;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(partFile, { flags: resumed ? 'a' : 'w' });
    res.on('data', (chunk: Buffer) => {
      done += chunk.length;
      if (done > model.size) {
        res.destroy(new Error(`model download exceeded pinned size ${model.size}`));
        return;
      }
      const step = Math.floor((done / model.size) * 200);
      if (step !== lastReported) {
        lastReported = step;
        onProgress(`Downloading ${label} (${mb(done)} / ${mb(model.size)} MB)`, done / model.size);
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
}

/** Downloads (resumable, sha256-verified) `model` into `dir`; returns its path.
 *  A file already on disk is used without re-hashing only while its verified
 *  marker still matches; otherwise it's re-hashed, and re-downloaded on mismatch. */
export async function ensurePinnedModel(
  model: PinnedModel,
  dir: string,
  onProgress: Progress = () => {},
  label = 'model',
): Promise<string> {
  const finalFile = path.join(dir, model.file);
  if ((await fileSize(finalFile)) === model.size) {
    if (await markerMatches(finalFile, model.sha256)) {
      onProgress(`${label} ready`, 1);
      return finalFile;
    }
    onProgress(`Verifying ${label}`, undefined);
    if ((await sha256File(finalFile)) === model.sha256) {
      await writeMarker(finalFile, model.sha256);
      onProgress(`${label} ready`, 1);
      return finalFile;
    }
  }
  await rm(finalFile, { force: true });
  await rm(markerPath(finalFile), { force: true });
  await mkdir(dir, { recursive: true });

  const partFile = `${finalFile}.part`;
  const partSize = await fileSize(partFile);
  if (partSize > model.size) await rm(partFile, { force: true });
  if (partSize !== model.size) {
    onProgress(`Downloading ${label}…`, 0);
    await download(model, partFile, onProgress, label);
  }

  onProgress(`Verifying ${label}`, undefined);
  const size = await fileSize(partFile);
  const digest = size === model.size ? await sha256File(partFile) : '';
  if (digest !== model.sha256) {
    await rm(partFile, { force: true });
    throw new Error(`${label} failed verification (size ${size}, sha256 ${digest || 'n/a'})`);
  }
  await rename(partFile, finalFile);
  await writeMarker(finalFile, model.sha256);
  onProgress(`${label} ready`, 1);
  return finalFile;
}

export interface WhisperOptions {
  /** Path to `whisper-server` (whisper.cpp). */
  bin: string;
  /** Path to a ggml model file (see `ensurePinnedModel`). */
  model: string;
  /** Working dir for the pid file and the empty public dir. */
  workDir: string;
  /** Default `auto`. */
  language?: string;
  /** Model load + first Metal compile is ~15s on Apple Silicon. Default 120s. */
  readyTimeoutMs?: number;
  /** Restarts after a post-readiness crash. Default 3. */
  maxRestarts?: number;
  /** Default [1s, 4s, 15s]. */
  restartBackoffMs?: number[];
  extraArgs?: string[];
  log?: Logger;
}

export interface WhisperEndpoint {
  /** Includes the secret path prefix; POST `${url}/inference`. */
  url: string;
  /** Resolves once the model is loaded; rejects if it never gets there. */
  ready: Promise<void>;
  stop: () => void;
}

export function whisperArgs(
  opts: Pick<WhisperOptions, 'model' | 'language' | 'extraArgs'>,
  port: number,
  secret: string,
  publicDir: string,
): string[] {
  return [
    '--host', LOOPBACK,
    '--port', String(port),
    '--model', opts.model,
    '--language', opts.language ?? 'auto',
    '--request-path', `/${secret}`,
    '--public', publicDir,
    ...(opts.extraArgs ?? []),
  ];
}

function httpStatus(url: string, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
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

/** Spawns whisper-server on a free loopback port and returns immediately;
 *  `ready` resolves once the model is loaded. Port and secret are fixed for
 *  the session, so a supervised restart keeps `url` valid.
 *
 *  whisper-server answers with `Access-Control-Allow-Origin: *`, so every
 *  route sits behind a random per-session path prefix — otherwise any web
 *  page could POST audio to 127.0.0.1:<port>/inference (or /load a file). */
export async function startWhisper(opts: WhisperOptions): Promise<WhisperEndpoint> {
  const log = opts.log ?? consoleLogger;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
  const maxRestarts = opts.maxRestarts ?? 3;
  const backoff = opts.restartBackoffMs ?? [1_000, 4_000, 15_000];
  if (!existsSync(opts.bin)) throw new Error(`whisper-server not found at ${opts.bin}.`);

  await mkdir(opts.workDir, { recursive: true });
  const pidFile = path.join(opts.workDir, 'whisper-server.pid');

  // A crashed app leaves whisper-server holding the model in RAM. Reap it —
  // only if the pid is still a whisper-server, never a recycled unrelated pid.
  try {
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0 && isProcessNamed(pid, path.basename(opts.bin))) {
      log('warn', 'whisper', `reaping stale whisper-server (pid ${pid})`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no pid file */
  }
  await rm(pidFile, { force: true });

  // whisper-server serves `--public` at the unprefixed `/`: keep it empty.
  const publicDir = path.join(opts.workDir, 'public');
  await mkdir(publicDir, { recursive: true });
  for (const entry of await readdir(publicDir)) {
    await rm(path.join(publicDir, entry), { recursive: true, force: true });
  }

  const port = await findFreePort();
  const secret = randomBytes(16).toString('hex');
  const url = `http://${LOOPBACK}:${port}/${secret}`;
  const args = whisperArgs(opts, port, secret, publicDir);

  let child: ChildProcess | null = null;
  let stopping = false;
  let restarts = 0;
  let everReady = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The caller may never await `ready`.
  ready.catch(() => {});

  const waitHealthy = async (proc: ChildProcess): Promise<boolean> => {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) return false;
      if ((await httpStatus(`${url}/health`)) === 200) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!proc.killed) proc.kill();
    return false;
  };

  const launch = () => {
    log('info', 'whisper', `starting${restarts ? ` (restart ${restarts}/${maxRestarts})` : ''}`);
    const proc = spawn(opts.bin, args, { cwd: opts.workDir, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    if (proc.pid) void writeFile(pidFile, String(proc.pid), { mode: 0o600 });
    pipeOutput(proc, 'whisper');
    proc.on('exit', (code, signal) => {
      void rm(pidFile, { force: true });
      if (stopping) return;
      log('error', 'whisper', `exited (code ${code}, signal ${signal})`);
      if (!everReady) {
        rejectReady(new Error(`whisper-server exited (code ${code}) before becoming ready`));
        return;
      }
      if (restarts >= maxRestarts) {
        log('error', 'whisper', `gave up after ${maxRestarts} restarts`);
        return;
      }
      const delay = backoff[Math.min(restarts, backoff.length - 1)] ?? 1_000;
      restarts += 1;
      setTimeout(() => {
        if (!stopping) launch();
      }, delay);
    });
    void waitHealthy(proc).then((healthy) => {
      if (stopping) return;
      if (!healthy) {
        if (!everReady) rejectReady(new Error(`whisper-server not ready within ${readyTimeoutMs / 1000}s`));
        return;
      }
      log('info', 'whisper', `ready on port ${port}`);
      if (!everReady) {
        everReady = true;
        resolveReady();
      }
    });
  };
  launch();

  return {
    url,
    ready,
    stop: () => {
      stopping = true;
      if (child && child.exitCode === null && !child.killed) child.kill();
    },
  };
}
