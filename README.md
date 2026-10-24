# local-ai-stack

Run a full **Postgres + pgvector / PostgREST / Redis / Ollama / whisper.cpp**
stack inside an Electron app — no Docker, nothing for the user to install.

Each service is a native binary you ship in the app bundle, started on
loopback by a small TypeScript function that handles the unglamorous parts:

- **Postgres**: `initdb` on first run, a psql-free migration runner
  (prelude → migrations → postlude, tracked and idempotent), schema
  re-apply only when the inputs change, and self-healing after a force-quit
  (orphaned postmaster / stale `postmaster.pid`).
- **PostgREST**: refuses to hand traffic to a non-PostgREST process on its
  port, restarts an adopted instance when the schema changed (its cache is
  startup-only), and waits for the schema cache — not just the port.
- **Redis**: loopback, append-only persistence; Microsoft Garnet on Windows.
- **Ollama**: reuses a running Ollama, kills a child that never became
  responsive, model pulls with plain-language progress.
- **whisper.cpp server**: every route behind a random per-session path
  (whisper-server sends `Access-Control-Allow-Origin: *`), supervised
  restarts with backoff, stale-process reaping, resumable sha256-pinned
  model download.
- **`supervise()`**: restarts any other long-running child (workers, queue
  listeners) with backoff when it exits unexpectedly.

Extracted from the [Kallam](https://kallam.ai) desktop app, where it runs the
on-device mode. By Kallam.

## Install

```sh
npm install @kallamtech/local-ai-stack
```

Node ≥ 20. Electron is an optional peer dependency — the main entry point
doesn't import it, so the sidecars also work from plain Node.

## Use

```ts
import crypto from 'node:crypto';
import { startPostgres, startPostgrest, startRedis } from '@kallamtech/local-ai-stack';
import { dataPath, persistentSecret, resourcePath, stopOnQuit } from '@kallamtech/local-ai-stack/electron';

const res = (...p: string[]) => resourcePath(__dirname, ...p); // Resources/ when packaged
const fresh = () => crypto.randomBytes(24).toString('hex');

const pg = await startPostgres({
  binDir: res('pg', 'bin'),
  dataDir: dataPath('pgdata'),
  database: 'app',
  password: persistentSecret('postgres'), // scram-sha-256; kept in safeStorage
  settings: { wal_level: 'logical' },   // optional GUCs
  schema: {
    prelude: [res('db', 'prelude.sql')],  // roles, schemas, extensions — idempotent
    migrationsDir: res('db', 'migrations'),
    postlude: [res('db', 'postlude.sql')],
    searchPath: 'public, extensions',
  },
});
const authenticatorPw = fresh();
await pg.setPassword('authenticator', authenticatorPw);
const rest = await startPostgrest({
  bin: res('bin', 'postgrest'),
  dbUri: pg.url('authenticator', authenticatorPw),
  anonRole: 'web_anon',
  jwtSecret: fresh(),                     // or: allowAnonymous + unixSocket behind your own proxy
  extraSearchPath: ['public', 'extensions'],
  schemaChanged: pg.schemaChanged,
});
const redis = await startRedis({
  bin: res('bin', 'redis-server'),
  dataDir: dataPath('redis'),
  password: fresh(),                      // a new one per launch is fine
});

stopOnQuit(async () => {
  rest.stop();
  redis.stop();
  await pg.stop(); // detached postmaster: await it
});
```

See [`examples/minimal-app`](examples/minimal-app) for a runnable app and the
prelude/migration layout.

### Ollama and whisper

```ts
import { startOllama, ensureModel, startWhisper, ensurePinnedModel,
  WHISPER_LARGE_V3_TURBO_Q5 } from '@kallamtech/local-ai-stack';

const ollama = await startOllama({ bin: res('bin', 'ollama'), modelsDir: dataPath('ollama-models') });
await ensureModel(ollama.url, 'nomic-embed-text', (phase, fraction) => ui.progress(phase, fraction));

const model = await ensurePinnedModel(WHISPER_LARGE_V3_TURBO_Q5, dataPath('whisper-models'));
const whisper = await startWhisper({ bin: res('bin', 'whisper-server'), model, workDir: dataPath('whisper') });
await whisper.ready;
// POST audio to `${whisper.url}/inference`
```

`keepAlive` defaults to `-1`: models stay loaded until Ollama is stopped,
which keeps the first token fast. Watch memory if you mix models. When a
model doesn't fit beside the resident ones, Ollama's scheduler evicts to make
room, and that path can deadlock: the load waits forever and every later
cold load queues behind it
([ollama#17408](https://github.com/ollama/ollama/issues/17408); we hit it on
0.40.3 with a pinned `*-mlx` model and a CPU-only embedding model). Loading an
MLX model checks it against the machine's free RAM, so even a small CPU-only
model loaded beside it can trigger the eviction. Until it is fixed:

- before a cold load of a GPU model, unload **every** other model
  (`keep_alive: 0`) and wait until `/api/ps` no longer lists them, so the
  scheduler never has to evict;
- hold other requests (embeddings included) until the new model has answered,
  so nothing races the load;
- after that, a CPU-only model (`options: { num_gpu: 0 }`) can reload beside
  it: a CPU-only load never evicts;
- put a timeout on every request, so a stuck load fails instead of hanging.
  With streamed responses, bound the silence (the read timeout) rather than
  the whole generation.

### Restarting workers

```ts
import { spawn } from 'node:child_process';
import { supervise } from '@kallamtech/local-ai-stack';

const worker = supervise({
  label: 'worker',
  spawn: () => spawn(python, ['worker.py'], { stdio: 'inherit' }),
  onSpawn: (child) => writePidFile(child.pid),
});
// on quit:
await worker.stop();
```

An exit that `stop()` didn't ask for restarts the process after 1s, doubling
up to 30s; a process that stays up 60s resets the backoff. `maxRestarts`
caps consecutive restarts (default unlimited).

## Security

Loopback is not a security boundary. Anything on the machine can connect to
`127.0.0.1` — other apps, other OS users, and web pages in the user's browser
(directly, or through DNS rebinding). The defaults assume that:

| Service | Default | Opt-out |
|---|---|---|
| Postgres | scram-sha-256 on every connection; unix socket mode 0700. `password` is required. An existing trust-auth cluster is converted on first start, and a lost password is reset in single-user mode. | `trust: true` (tests, throwaway data) |
| PostgREST | `jwtSecret` is required. `unixSocket` serves on an owner-only socket (mode 600, parent dir 0700) instead of TCP, so no browser can reach it. `corsAllowedOrigins` pins CORS on a TCP listener, which otherwise reflects any Origin. | `allowAnonymous: true` — only with `unixSocket` behind your own authenticating proxy |
| Redis | `password` sets `requirepass`, passed over stdin rather than argv (`ps` shows argv). Garnet only accepts argv. An instance that rejects the password is replaced, not adopted. | omit `password` |
| whisper | every route sits behind a random per-launch path prefix | — |
| Ollama | loopback; Ollama's default origin allowlist blocks web pages | — |

Keep long-lived secrets out of plaintext: `persistentSecret(name)` (from
`/electron`) stores a random secret under userData, encrypted with
`safeStorage`. Passwords that only need to live for one launch (PostgREST's
login role, Redis) can simply be regenerated every launch.

If you run anonymous PostgREST behind a proxy, that proxy is now the
boundary. Check the `Host` header against an allowlist (DNS rebinding), lock
CORS, and require a token on mutating routes.

### Migrating from a hosted database

The prelude is where a bare Postgres is made to look like what your
migrations expect, without editing them. For Supabase-generated migrations
that means creating the roles they grant to (`anon`, `authenticated`,
`service_role`, `authenticator`, …), the schemas they assume (`auth`,
`storage`, `extensions`, …) and stubs for hosted-only functions. Extensions a
stock build doesn't have can be dropped from migrations with
`schema.stripExtensions: ['pg_cron', 'pg_net', ...]`.

Migrations are applied in-process as one multi-statement query per file, so
`CREATE INDEX CONCURRENTLY` is not supported in them.

## API

| Function | Returns |
|---|---|
| `startPostgres(opts)` | `{ port, dataDir, database, url(role?, password?), setPassword(role, pw), schemaChanged, initialized, stop() }` |
| `startPostgrest(opts)` | `{ url, port, socketPath, child, adoptedPid, stop() }` |
| `startRedis(opts)` | `{ host, port, password, url, child, adoptedPid, stop() }` |
| `startOllama(opts)` | `{ url, ownedByUs, child, stop() }` |
| `ensureModel(url, model, onProgress?, label?)` | pulls an Ollama model if missing |
| `startWhisper(opts)` | `{ url, ready, stop() }` |
| `ensurePinnedModel(model, dir, onProgress?, label?)` | path to a verified download |
| `supervise(opts)` | `{ child, stop(signal?) }`; restarts the child on unexpected exit |
| `applySchema`, `ensureDatabase`, `schemaFingerprint` | the migration runner, standalone |
| `stageBundle(src, dest, version)` | copy a read-only bundled dir somewhere writable, once per version |
| `isPortOpen`, `waitForPort`, `findFreePort`, `findListenerPid`, `withoutEnv` | helpers |
| `redisAccepts(port, password?)` | whether a Redis on `port` accepts the credentials |
| `electron`: `resourcePath`, `dataPath`, `stopOnQuit`, `persistentSecret` | Electron-only helpers |

Every option is documented on its TypeScript type. All TCP listeners bind
`127.0.0.1` only (see [Security](#security) for why that alone isn't enough). Every `start*` takes a `log` callback (default: console).

## Bundling the binaries

```sh
bash node_modules/@kallamtech/local-ai-stack/scripts/build-pg-bundle.sh pg
bash node_modules/@kallamtech/local-ai-stack/scripts/build-bin.sh bin postgrest redis ollama whisper
```

- `build-pg-bundle.sh` takes the relocatable Postgres 15 server binaries from
  the [`@embedded-postgres`](https://github.com/leinelissen/embedded-postgres)
  packages and adds pgvector, built from source against a PG15 dev install
  (`PG_CONFIG`; `brew install postgresql@15` on macOS). Windows needs a
  prebuilt `vector.dll` (`SIDECARS_PGVECTOR_DLL`, `SIDECARS_PGVECTOR_SQLDIR`).
- `build-bin.sh` fetches PostgREST and Ollama releases and builds Redis and
  whisper-server from pinned sources. On macOS it rewrites PostgREST's libpq
  install name to `@executable_path/../pg/lib`, so keep `bin/` and `pg/` as
  siblings in Resources.

Ship `pg/` and `bin/` with electron-builder `extraResources`. Signing and
notarizing them is your build's job.

## Platform support

| | status |
|---|---|
| macOS arm64 | **primary target** — what the Kallam on-device desktop build runs on; integration test passes |
| macOS x64 | should work, not tested |
| Linux x64 / arm64 | scripts have asset mappings; not tested end to end |
| Windows x64 | Postgres/PostgREST/Garnet/Ollama mappings exist; whisper not built; not tested end to end |

`findListenerPid` uses `lsof` and returns `null` where it's unavailable.

## Development

```sh
npm install
npm run typecheck && npm run lint && npm test
```

Running the integration test (real binaries, otherwise skipped):

```sh
SIDECARS_PG_BINDIR=pg/bin SIDECARS_PG_LIBDIR=pg/lib \
SIDECARS_POSTGREST_BIN=bin/postgrest SIDECARS_REDIS_BIN=bin/redis-server \
npm test
```

## License

Apache-2.0. Copyright 2026 Kallam. Bundled third-party binaries keep their
own licenses (PostgreSQL, pgvector, PostgREST, Redis, Garnet, Ollama,
whisper.cpp) — check them before you ship.
