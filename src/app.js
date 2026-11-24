'use strict';

const express = require('express');
const client = require('prom-client');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = process.env.APP_VERSION || 'v1';
// FAIL_RATE lets the demo degrade a *fraction* of traffic instead of all of it,
// which is what makes a canary analysis meaningful (100% failure is the easy case).
// FAIL_MODE=true is shorthand for FAIL_RATE=100, and fail_mode in /health is
// simply "is this instance degrading traffic at all".
const FAIL_RATE = Number(
  process.env.FAIL_RATE ?? (process.env.FAIL_MODE === 'true' ? 100 : 0)
);
const FAIL_MODE = FAIL_RATE > 0;
const ENV = process.env.APP_ENV || 'demo';

/* ------------------------------------------------------------------ metrics */

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'nodejs_' });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests handled, by method, route and status code.',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds.',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

// `route` is the *matched route pattern* (e.g. "/api/orders"), not the raw path,
// so label cardinality stays bounded. kubelet probes and Prometheus scrapes are
// recorded too: the PromQL used by the AnalysisTemplate filters them out.
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = (req.route && req.route.path) || 'unmatched';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequestsTotal.labels(labels.method, labels.route, labels.status).inc();
    end({ method: labels.method, route: labels.route, status: labels.status });
  });
  next();
});

app.use(express.json({ limit: '32kb' }));

// Every response carries the version that served it: this is how the canary is
// proven to be receiving traffic in the demo (`curl -i` shows X-App-Version).
app.use((req, res, next) => {
  res.setHeader('X-App-Version', APP_VERSION);
  next();
});

/* ----------------------------------------------------------------- endpoints */

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: APP_VERSION,
    env: ENV,
    fail_mode: FAIL_MODE,
    fail_rate: FAIL_RATE,
  });
});

app.get('/ready', (req, res) => {
  res.status(200).json({ status: 'ready', version: APP_VERSION });
});

app.get('/live', (req, res) => {
  res.status(200).json({ status: 'live', version: APP_VERSION });
});

const ORDERS = [
  { id: '1', item: 'mechanical-keyboard', qty: 1, status: 'created' },
  { id: '2', item: 'usb-c-hub', qty: 2, status: 'shipped' },
  { id: '3', item: 'desk-mat', qty: 1, status: 'created' },
];

app.get('/api/orders', (req, res) => {
  // Deterministic-ish failure injection: FAIL_RATE percent of requests fail.
  // With FAIL_MODE=true it is 100%, which is what the v3 demo image uses.
  if (FAIL_RATE > 0 && Math.random() * 100 < FAIL_RATE) {
    return res.status(500).json({
      error: 'simulated failure',
      version: APP_VERSION,
      fail_rate: FAIL_RATE,
    });
  }
  res.json({ version: APP_VERSION, count: ORDERS.length, orders: ORDERS });
});

app.get('/api/orders/:id', (req, res) => {
  const order = ORDERS.find((o) => o.id === req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'not found', version: APP_VERSION });
  }
  res.json({ version: APP_VERSION, order });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path });
});

/* -------------------------------------------------------------------- server */

function start() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(
      `orders-api ${APP_VERSION} listening on :${PORT} (env=${ENV}, fail_rate=${FAIL_RATE}%)`
    );
  });

  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, draining connections`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start, register };
