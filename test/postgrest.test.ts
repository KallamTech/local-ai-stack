import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { isPostgrest, startPostgrest, type PostgrestOptions } from '../src/postgrest.js';

function serve(server: string | undefined): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      if (server) res.setHeader('Server', server);
      res.end('{}');
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: (srv.address() as AddressInfo).port, close: () => srv.close() });
    });
  });
}

const base = (port: number): PostgrestOptions => ({
  bin: process.execPath,
  dbUri: 'postgresql://authenticator@127.0.0.1:1/app',
  anonRole: 'web_anon',
  allowAnonymous: true,
  port,
  log: () => {},
});

test('an existing PostgREST is adopted only with adoptExisting', async () => {
  const srv = await serve('postgrest/14.15');
  try {
    assert.equal(await isPostgrest(`http://127.0.0.1:${srv.port}`), true);
    await assert.rejects(startPostgrest(base(srv.port)), /already has a PostgREST instance.*adoptExisting/);
    const rest = await startPostgrest({ ...base(srv.port), adoptExisting: true });
    assert.equal(rest.child, null);
    assert.equal(rest.port, srv.port);
  } finally {
    srv.close();
  }
});

test('a non-PostgREST listener is never adopted', async () => {
  const srv = await serve(undefined);
  try {
    assert.equal(await isPostgrest(`http://127.0.0.1:${srv.port}`), false);
    await assert.rejects(startPostgrest({ ...base(srv.port), adoptExisting: true }), /non-PostgREST process/);
  } finally {
    srv.close();
  }
});
