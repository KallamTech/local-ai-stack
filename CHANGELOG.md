# Changelog

## Unreleased

Security review follow-ups. Breaking for TCP-mode PostgREST (see `adoptExisting`).

- **PostgREST:** a PostgREST already on the TCP port is no longer reused by default — any local process could sit there answering as PostgREST and receive the app's database traffic. New `adoptExisting: true` restores the old behaviour for an instance known to be yours; `unixSocket` is unchanged. In socket mode the leftover pidfile is only acted on when the pid is still a PostgREST process.
- **Redis:** a port held by something that does not answer as Redis is now an error instead of being killed. Only a Redis that rejects the credentials (`NOAUTH`/`WRONGPASS`/`AUTH` without `requirepass`) is replaced. New `probeRedis(port, password?)` → `accepted` / `rejected` / `unknown`.
- **Postgres:** `settings` can no longer override `listen_addresses`, `port` or the unix socket settings, and values (plus `socketDir`) are rejected when they contain characters the shell behind `pg_ctl -o` would interpret.
- **Migrations:** `searchPath` is validated before it is interpolated into `SET search_path`.
- **whisper:** a model download that exceeds the pinned size is aborted instead of written to disk until the hash check fails.
- **Build scripts:** every download is sha256-checked and every git checkout commit-pinned. Ollama is pinned to v0.40.11 (digests from its `sha256sum.txt`; Linux assets are now `.tar.zst`), Redis comes from `download.redis.io` with the digest from `redis/redis-hashes`, pgvector and Garnet are pinned by commit. PostgREST publishes no checksums, so `SIDECARS_POSTGREST_SHA256` is required; the Linux x64 and Windows PostgREST asset names were wrong and are fixed.
- README: the stale "not on npm yet" note is gone. Example app: electron 41.

## 0.4.1

No code changes. 0.4.0 was published by hand; this is the first release built and published from CI, with npm provenance.

## 0.4.0

Renamed from `electron-sidecars` to `@kallamtech/local-ai-stack`; first release on npm. No API changes. The `SIDECARS_*` environment variables are unchanged.

## 0.3.2

- No runtime changes. Dev dependency update (electron 41) and the first release published from CI with npm provenance.

## 0.3.1

- README: Ollama memory note corrected. A small CPU-only model doesn't make an MLX load safe; unload every other model before a cold GPU load and hold requests until it answers (ollama#17408).

## 0.3.0

- New `supervise()`: restarts a long-running child (worker, queue listener) with backoff when it exits unexpectedly; `stop()` ends it for good.
- README: Ollama memory note. Loads that need the scheduler to evict can deadlock (ollama#17408); how to avoid it.

## 0.2.0

Secure by default. Breaking: every service now needs an explicit auth choice.

- **Postgres:** scram-sha-256 everywhere. `password` is required unless `trust: true`. An existing trust-auth cluster is converted on first start with a password (single-user `ALTER ROLE`, then `pg_hba.conf` rewritten), and a password the cluster rejects is reset the same way. Unix socket permissions are 0700. New `setPassword(role, pw)`, and `url(role, password)`.
- **PostgREST:** `jwtSecret` is required unless `allowAnonymous: true`. New `unixSocket` (mode 600, parent dir 0700, no TCP listener; a leftover instance is found via a pidfile and replaced) and `corsAllowedOrigins`. The endpoint gains `socketPath`; `port` is `null` on a socket.
- **Redis:** new `password` (`requirepass` over stdin, not argv). An instance on the port that rejects it is replaced instead of adopted. New `redisAccepts()`.
- **Electron:** new `persistentSecret(name)`, a safeStorage-encrypted random secret under userData.
- README: Security section. Example app uses the secure defaults.
- CI: actions pinned by commit, read-only token by default, npm pinned, publishing gated on the `npm` environment.

## 0.1.0

Initial release.
