import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { findFreePort } from '../src/net.js';
import { probeRedis, redisAccepts, startRedis } from '../src/redis.js';

function fakeServer(reply: string | ((req: string) => string)): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => {
      s.once('data', (d) => s.write(typeof reply === 'function' ? reply(d.toString()) : reply));
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() });
    });
  });
}

test('probeRedis classifies replies', async () => {
  const cases: [string, string][] = [
    ['+PONG\r\n', 'accepted'],
    ['+OK\r\n+PONG\r\n', 'accepted'],
    ['-NOAUTH Authentication required.\r\n', 'rejected'],
    ['-WRONGPASS invalid username-password pair\r\n-NOAUTH Authentication required.\r\n', 'rejected'],
    ['-ERR AUTH <password> called without any password configured for the default user.\r\n+PONG\r\n', 'rejected'],
    ['-ERR unknown command\r\n', 'unknown'],
    ['HTTP/1.1 400 Bad Request\r\n\r\n', 'unknown'],
  ];
  for (const [reply, expected] of cases) {
    const srv = await fakeServer(reply);
    try {
      assert.equal(await probeRedis(srv.port, 'pw'), expected, JSON.stringify(reply));
    } finally {
      srv.close();
    }
  }
  const silent = await fakeServer('');
  try {
    assert.equal(await probeRedis(silent.port, undefined, 200), 'unknown');
    assert.equal(await redisAccepts(silent.port, undefined, 200), false);
  } finally {
    silent.close();
  }
  assert.equal(await probeRedis(await findFreePort(), 'pw', 200), 'unknown');
});

test('startRedis refuses a port held by something that is not Redis', async () => {
  const srv = await fakeServer('HTTP/1.1 400 Bad Request\r\n\r\n');
  try {
    await assert.rejects(
      startRedis({ bin: '/nonexistent', dataDir: '/nonexistent', port: srv.port, password: 'pw', log: () => {} }),
      new RegExp(`Port ${srv.port} is held by a process that does not answer as Redis`),
    );
  } finally {
    srv.close();
  }
});
