import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applySchema, assertIdent, schemaFingerprint, stripExtensionLines } from '../src/migrate.js';

test('strips only the listed CREATE EXTENSION lines', () => {
  const sql = [
    'CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";',
    '  create extension pg_net;',
    'CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "extensions";',
    'CREATE EXTENSION IF NOT EXISTS "pg_cronx";',
    'SELECT 1;',
  ].join('\n');
  const out = stripExtensionLines(sql, ['pg_cron', 'pg_net']);
  assert.doesNotMatch(out, /"pg_cron"/);
  assert.doesNotMatch(out, /pg_net/);
  assert.match(out, /"vector"/);
  assert.match(out, /pg_cronx/);
  assert.match(out, /SELECT 1/);
  assert.equal(stripExtensionLines(sql, []), sql);
});

test('identifier guard', () => {
  assert.equal(assertIdent('my_app'), 'my_app');
  assert.throws(() => assertIdent('x"; DROP'), /unsafe/);
});

test('search_path is checked before connecting', async () => {
  await assert.rejects(applySchema('postgresql://x', { searchPath: 'public; DROP SCHEMA public' }), /unsafe search_path/);
  await assert.rejects(applySchema('postgresql://x', { trackingTable: 'a.b.c' }), /unsafe tracking table/);
});

test('fingerprint tracks newest migration and prelude contents, not paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidecars-fp-'));
  const mig = path.join(root, 'migrations');
  await mkdir(mig);
  await writeFile(path.join(mig, '001_a.sql'), 'select 1;');
  const prelude = path.join(root, 'prelude.sql');
  await writeFile(prelude, 'select 0;');
  const fp1 = await schemaFingerprint({ migrationsDir: mig, prelude: [prelude] });
  assert.match(fp1, /^001_a\.sql\+[0-9a-f]{12}$/);

  await writeFile(path.join(mig, '002_b.sql'), 'select 2;');
  const fp2 = await schemaFingerprint({ migrationsDir: mig, prelude: [prelude] });
  assert.match(fp2, /^002_b\.sql\+/);

  await writeFile(prelude, 'select 00;');
  const fp3 = await schemaFingerprint({ migrationsDir: mig, prelude: [prelude] });
  assert.notEqual(fp3.split('+')[1], fp2.split('+')[1]);

  const moved = path.join(root, 'elsewhere');
  await mkdir(moved);
  await writeFile(path.join(moved, 'prelude.sql'), 'select 00;');
  assert.equal(await schemaFingerprint({ migrationsDir: mig, prelude: [path.join(moved, 'prelude.sql')] }), fp3);
});
