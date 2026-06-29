/**
 * sdk/node/next.instrumentation.ts
 * ─────────────────────────────────────────────────────────────
 * OpenTelemetry instrumentation for Next.js 13.4+
 *
 * Next.js has native OTel support. This file is auto-loaded by
 * the Next.js runtime — no imports needed in your code.
 *
 * SETUP:
 *   1. Copy this file to your project root as:
 *        instrumentation.ts   (App Router — Next.js 13.4+)
 *
 *   2. Enable in next.config.js / next.config.ts:
 *        experimental: { instrumentationHook: true }
 *      (Not needed in Next.js 15+ — enabled by default)
 *
 *   3. Install packages:
 *        npm install \
 *          @opentelemetry/sdk-node \
 *          @opentelemetry/exporter-trace-otlp-http \
 *          @opentelemetry/resources \
 *          @opentelemetry/semantic-conventions
 *
 *   4. Set env vars in Coolify or .env.local:
 *        OTEL_SERVICE_NAME=my-nextjs-app
 *        OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
 *        NEXT_OTEL_VERBOSE=0
 *
 * NOTE: Next.js runs on both Node.js (server) and Edge runtimes.
 * OTel SDK only initializes in the Node.js runtime (server-side).
 * Edge functions use HTTP export (port 4318) not gRPC (port 4317).
 * ─────────────────────────────────────────────────────────────
 */

export async function register() {
  // Only run on the Node.js server runtime (not Edge, not browser)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = await import('@opentelemetry/resources');
    const {
      SEMRESATTRS_SERVICE_NAME,
      SEMRESATTRS_SERVICE_VERSION,
      SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
    } = await import('@opentelemetry/semantic-conventions');

    // Next.js uses HTTP (4318) not gRPC (4317) for Edge compatibility
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://otel-collector:4318';

    const sdk = new NodeSDK({
      resource: new Resource({
        [SEMRESATTRS_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'nextjs-app',
        [SEMRESATTRS_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
        [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]:
          process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
      }),
      // Use HTTP exporter — works with both Node and Edge runtimes
      traceExporter: new OTLPTraceExporter({
        url: `${endpoint}/v1/traces`,
      }),
    });

    sdk.start();

    console.log(
      `[OTel] Next.js instrumented → ${endpoint} | service: ${process.env.OTEL_SERVICE_NAME ?? 'nextjs-app'}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// NEXT.JS + GLITCHTIP / SENTRY
// ─────────────────────────────────────────────────────────────
// Install: npm install @sentry/nextjs
//
// Run the Sentry wizard which creates sentry.client.config.ts,
// sentry.server.config.ts, and sentry.edge.config.ts.
// Just change the DSN to your GlitchtTip DSN:
//
// Sentry.init({
//   dsn: process.env.SENTRY_DSN,   // point to GlitchTip
//   environment: process.env.NODE_ENV,
//   tracesSampleRate: 0,           // tracing handled by OTel above
// });
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// VERCEL DEPLOYMENT NOTE
// ─────────────────────────────────────────────────────────────
// If deploying to Vercel instead of Coolify:
//   - OTel Collector must be publicly reachable or use Vercel's
//     OTEL endpoint (available on Enterprise plan).
//   - Use OTEL_EXPORTER_OTLP_ENDPOINT=https://your-server:4318
//   - Secure port 4318 behind Traefik + a domain via Coolify UI.
// ─────────────────────────────────────────────────────────────
