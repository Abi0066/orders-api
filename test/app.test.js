'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { app } = require('../src/app');

const PORT = Number(process.env.TEST_PORT || 3100 + Math.floor(Math.random() * 400));

test('endpoints', async (t) => {
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${PORT}`;

  t.after(() => server.close());

  await t.test('/health exposes status, version and fail_mode', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.version, 'v1');
    assert.equal(body.fail_mode, false);
    assert.equal(res.headers.get('x-app-version'), 'v1');
  });

  await t.test('/ready and /live return 200', async () => {
    for (const p of ['/ready', '/live']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, `${p} should be 200`);
    }
  });

  await t.test('/api/orders returns a list', async () => {
    const res = await fetch(`${base}/api/orders`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.orders));
    assert.ok(body.orders.length >= 1);
  });

  await t.test('unknown route returns 404 JSON', async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not found');
  });

  await t.test('/metrics is Prometheus text format', async () => {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();
    assert.match(text, /# TYPE http_requests_total counter/);
    assert.match(text, /http_requests_total\{method="GET",route="\/health",status="200"\}/);
  });
});

test('FAIL_RATE=100 makes /api/orders fail', async (t) => {
  const port = PORT + 500;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'app.js')], {
    env: { ...process.env, PORT: String(port), APP_VERSION: 'v3', FAIL_RATE: '100' },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGTERM'));

  // wait for the port to answer
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/live`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const res = await fetch(`http://127.0.0.1:${port}/api/orders`);
  assert.equal(res.status, 500);
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.fail_mode, true);
  assert.equal(health.fail_rate, 100);
});
