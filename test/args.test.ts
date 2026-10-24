import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutEnv } from '../src/env.js';
import { friendlyPullStatus, normalizeModelId } from '../src/ollama.js';
import { initdbArgs, pgCtlStartArgs, secureHba, serverOptions, sqlLiteral } from '../src/postgres.js';
import { postgrestEnv } from '../src/postgrest.js';
import { detectFlavor, redisConfig, redisServerArgs } from '../src/redis.js';
import { whisperArgs } from '../src/whisper.js';

test('initdb uses scram with a pwfile, trust only without one', () => {
  assert.deepEqual(initdbArgs('/d', 'admin', '/p'), [
    '-D', '/d', '-U', 'admin', '--no-locale', '-E', 'UTF8', '-A', 'scram-sha-256', '--pwfile=/p',
  ]);
  assert.deepEqual(initdbArgs('/d', 'admin', null).slice(-2), ['-A', 'trust']);
});

test('secureHba switches trust rules and leaves comments alone', () => {
  const conf = [
    '# "trust" in a comment stays trust',
    'local   all             all                                     trust',
    'host    all             all             127.0.0.1/32            trust',
    'host    all             all             ::1/128                 scram-sha-256',
    'local   replication     all                                     trust',
  ].join('\n');
  const { conf: out, changed } = secureHba(conf);
  assert.equal(changed, true);
  assert.doesNotMatch(out.split('\n').slice(1).join('\n'), /trust/);
  assert.match(out, /^# "trust" in a comment stays trust/);
  assert.equal(secureHba(out).changed, false);
});

test('sqlLiteral escapes quotes', () => {
  assert.equal(sqlLiteral("a'b"), "'a''b'");
});

test('serverOptions binds loopback, sets socket dir and settings', () => {
  assert.equal(
    serverOptions(5555, '/tmp', { wal_level: 'logical' }, 'darwin'),
    '-p 5555 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp -c unix_socket_permissions=0700 -c wal_level=logical',
  );
  assert.match(serverOptions(5555, null, {}, 'linux'), /unix_socket_directories='' /);
  assert.doesNotMatch(serverOptions(5555, '/tmp', {}, 'win32'), /unix_socket/);
  assert.throws(() => serverOptions(1, null, { 'bad key': 'x' }), /unsafe/);
  assert.throws(() => serverOptions(1, null, { k: "a' -c x=y" }), /unsafe/);
  assert.throws(() => serverOptions(1, null, { k: 'a;b' }), /unsafe/);
  assert.throws(() => serverOptions(1, '/Users/x/Library/Application Support/app', {}, 'darwin'), /unsafe socketDir/);
  assert.doesNotThrow(() => serverOptions(1, '/Users/x/Library/Application Support/app', {}, 'win32'));
});

test('pg_ctl start always redirects to a logfile', () => {
  const args = pgCtlStartArgs('/d', '-p 1');
  assert.equal(args[args.indexOf('-l') + 1], '/d/startup.log');
  assert.equal(args.at(-1), 'start');
});

test('redis args per flavor', () => {
  assert.deepEqual(redisServerArgs('redis', 6399, '/r'), [
    '--port', '6399', '--bind', '127.0.0.1', '--dir', '/r', '--appendonly', 'yes', '--save', '',
  ]);
  assert.ok(redisServerArgs('garnet', 6399, '/r').includes('--aof'));
  // The password itself never lands in argv for Redis: `-` reads it from stdin.
  const withPw = redisServerArgs('redis', 6399, '/r', 'hunter2');
  assert.equal(withPw[0], '-');
  assert.ok(!withPw.includes('hunter2'));
  assert.equal(redisConfig('abc123'), 'requirepass abc123\n');
  assert.throws(() => redisConfig('a b'), /whitespace/);
  assert.equal(detectFlavor('/x/garnet/GarnetServer.exe'), 'garnet');
  assert.equal(detectFlavor('/x/redis-server'), 'redis');
});

test('postgrest env', () => {
  const env = postgrestEnv(
    { bin: 'x', dbUri: 'postgresql://authenticator@127.0.0.1:1/app', anonRole: 'web_anon', extraSearchPath: ['public', 'extensions'], allowAnonymous: true },
    3001,
    {},
  );
  assert.equal(env.PGRST_DB_ANON_ROLE, 'web_anon');
  assert.equal(env.PGRST_DB_SCHEMAS, 'public');
  assert.equal(env.PGRST_DB_EXTRA_SEARCH_PATH, 'public, extensions');
  assert.equal(env.PGRST_SERVER_HOST, '127.0.0.1');
  assert.equal(env.PGRST_SERVER_PORT, '3001');
  assert.equal(env.PGRST_JWT_SECRET, undefined);
  assert.equal(env.DYLD_FALLBACK_LIBRARY_PATH, undefined);
  const withJwt = postgrestEnv({ bin: 'x', dbUri: 'u', anonRole: 'a', jwtSecret: 's', libDir: '/lib' }, 1, {});
  assert.equal(withJwt.PGRST_JWT_SECRET, 's');
  assert.equal(withJwt.DYLD_FALLBACK_LIBRARY_PATH, '/lib');
});

test('postgrest requires a JWT secret unless anonymous is explicit', () => {
  assert.throws(() => postgrestEnv({ bin: 'x', dbUri: 'u', anonRole: 'a' }, 1, {}), /jwtSecret/);
});

test('postgrest on a unix socket has no TCP listener; CORS origins pass through', () => {
  const env = postgrestEnv(
    { bin: 'x', dbUri: 'u', anonRole: 'a', allowAnonymous: true, unixSocket: '/run/p.sock', corsAllowedOrigins: ['http://localhost:3000', 'app://x'] },
    3001,
    {},
  );
  assert.equal(env.PGRST_SERVER_UNIX_SOCKET, '/run/p.sock');
  assert.equal(env.PGRST_SERVER_UNIX_SOCKET_MODE, '600');
  assert.equal(env.PGRST_SERVER_PORT, undefined);
  assert.equal(env.PGRST_SERVER_HOST, undefined);
  assert.equal(env.PGRST_SERVER_CORS_ALLOWED_ORIGINS, 'http://localhost:3000,app://x');
});

test('whisper args put every route behind the secret prefix', () => {
  const args = whisperArgs({ model: '/m.bin' }, 9000, 'abc', '/pub');
  assert.equal(args[args.indexOf('--request-path') + 1], '/abc');
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(args[args.indexOf('--language') + 1], 'auto');
});

test('model ids compare tag-normalized', () => {
  assert.equal(normalizeModelId('bge-m3'), 'bge-m3:latest');
  assert.equal(normalizeModelId('gemma:2b'), 'gemma:2b');
});

test('pull status is human-readable', () => {
  assert.equal(friendlyPullStatus('pulling 3f2a…', 'model'), 'Downloading model');
  assert.equal(friendlyPullStatus('verifying sha256 digest', 'model'), 'Verifying model');
  assert.equal(friendlyPullStatus('pulling manifest', 'model'), 'Preparing model');
  assert.equal(friendlyPullStatus('success', 'model'), 'Finishing model');
});

test('withoutEnv drops keys and prefixes', () => {
  const out = withoutEnv({ A: '1', SECRET: '2', GCP_X: '3', KEEP: '4' }, { keys: ['SECRET'], prefixes: ['GCP_'] });
  assert.deepEqual(out, { A: '1', KEEP: '4' });
});
