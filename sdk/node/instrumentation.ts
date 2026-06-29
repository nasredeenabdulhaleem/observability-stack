/**
 * sdk/node/instrumentation.ts
 * ─────────────────────────────────────────────────────────────
 * OpenTelemetry instrumentation for NestJS and Express.
 * Covers traces, metrics, and logs with full auto-instrumentation.
 *
 * INSTALL:
 *   npm install \
 *     @opentelemetry/sdk-node \
 *     @opentelemetry/auto-instrumentations-node \
 *     @opentelemetry/exporter-trace-otlp-grpc \
 *     @opentelemetry/exporter-metrics-otlp-grpc \
 *     @opentelemetry/exporter-logs-otlp-grpc \
 *     @opentelemetry/sdk-metrics \
 *     @opentelemetry/sdk-logs \
 *     @opentelemetry/resources \
 *     @opentelemetry/semantic-conventions
 *
 * USAGE — NestJS (main.ts):
 *   import './instrumentation';  // must be the VERY FIRST import
 *   import { NestFactory } from '@nestjs/core';
 *   ...
 *
 * USAGE — Express (server.ts):
 *   import './instrumentation';  // must be the VERY FIRST import
 *   import express from 'express';
 *   ...
 *
 * USAGE — CLI flag (no code change needed):
 *   node -r ./dist/instrumentation.js dist/main.js
 *
 * ENV VARS (set in .env or Coolify UI):
 *   OTEL_SERVICE_NAME          your-service-name
 *   OTEL_EXPORTER_OTLP_ENDPOINT  http://otel-collector:4317
 *   OTEL_DEPLOYMENT_ENVIRONMENT  production
 *   OTEL_TRACES_SAMPLER_ARG    1.0   (0.0–1.0, default 1.0)
 * ─────────────────────────────────────────────────────────────
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { Resource } from '@opentelemetry/resources';
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// ── Config from env vars ──────────────────────────────────────
const SERVICE_NAME    = process.env.OTEL_SERVICE_NAME ?? 'node-service';
const SERVICE_VERSION = process.env.npm_package_version ?? '0.0.0';
const ENVIRONMENT     = process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production';
const ENDPOINT        = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://otel-collector:4317';
const SAMPLE_RATE     = parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG ?? '1.0');
const METRIC_INTERVAL = parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? '30000', 10);

// Show OTel internal warnings in non-production environments
if (ENVIRONMENT !== 'production') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
}

// ── Resource: labels on every span, metric, and log ──────────
const resource = new Resource({
  [SEMRESATTRS_SERVICE_NAME]:            SERVICE_NAME,
  [SEMRESATTRS_SERVICE_VERSION]:         SERVICE_VERSION,
  [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]:  ENVIRONMENT,
});

// ── SDK setup ────────────────────────────────────────────────
const sdk = new NodeSDK({
  resource,

  // Traces → Tempo (via OTel Collector)
  traceExporter: new OTLPTraceExporter({ url: ENDPOINT }),

  // Metrics → Prometheus (via OTel Collector remote write)
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: ENDPOINT }),
    exportIntervalMillis: METRIC_INTERVAL,
  }),

  // Logs → Loki (via OTel Collector)
  logRecordProcessor: new SimpleLogRecordProcessor(
    new OTLPLogExporter({ url: ENDPOINT }),
  ),

  instrumentations: [
    getNodeAutoInstrumentations({
      // Auto-instruments: HTTP, Express, NestJS, Prisma, Redis,
      // PostgreSQL (pg), MongoDB, gRPC, fetch, DNS, and more.
      '@opentelemetry/instrumentation-fs': {
        // Disable filesystem instrumentation — too noisy
        enabled: false,
      },
      '@opentelemetry/instrumentation-http': {
        // Filter out health check endpoints from traces
        ignoreIncomingRequestHook: (req) => {
          const ignore = ['/health', '/healthz', '/ready', '/metrics', '/favicon.ico'];
          return ignore.some((path) => req.url?.startsWith(path));
        },
      },
    }),
  ],
});

// ── Start ─────────────────────────────────────────────────────
sdk.start();

console.log(
  `[OTel] ✓ ${SERVICE_NAME}@${SERVICE_VERSION} → ${ENDPOINT} | env: ${ENVIRONMENT} | sample: ${SAMPLE_RATE * 100}%`,
);

// ── Graceful shutdown ─────────────────────────────────────────
const shutdown = () => {
  sdk
    .shutdown()
    .then(() => console.log('[OTel] SDK shut down cleanly'))
    .catch((err) => console.error('[OTel] Shutdown error:', err))
    .finally(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─────────────────────────────────────────────────────────────
// CUSTOM METRICS — optional, add your own business metrics
// ─────────────────────────────────────────────────────────────
// Example (add to your service file, not here):
//
// import { metrics } from '@opentelemetry/api';
//
// const meter = metrics.getMeter('my-service');
//
// const requestCounter = meter.createCounter('api.requests.total', {
//   description: 'Total number of API requests',
// });
//
// const activeConnections = meter.createUpDownCounter('api.connections.active');
//
// const responseTime = meter.createHistogram('api.response_time_ms', {
//   description: 'API response time in milliseconds',
//   unit: 'ms',
// });
//
// // Use in your handler:
// requestCounter.add(1, { route: '/api/users', method: 'GET', status: '200' });
// responseTime.record(Date.now() - start, { route: '/api/users' });
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// NESTJS SENTRY / GLITCHTIP SETUP
// ─────────────────────────────────────────────────────────────
// In your app.module.ts:
//
// import * as Sentry from '@sentry/node';
//
// Sentry.init({
//   dsn: process.env.SENTRY_DSN,
//   environment: process.env.NODE_ENV,
//   release: process.env.npm_package_version,
//   tracesSampleRate: 0,  // tracing handled by OTel above
// });
// ─────────────────────────────────────────────────────────────
