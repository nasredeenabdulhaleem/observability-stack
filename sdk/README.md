# SDK Integration Guide

Connect any app on your server to the observability stack.
Two connection modes are supported — use whichever fits your setup.

---

## Connection modes

| Mode | When to use | Endpoint |
|------|-------------|----------|
| **Internal** (Docker network) | App on the same Coolify server | `http://otel-collector:4317` |
| **External** (host port) | App on a different server, or can't join the Docker network | `http://YOUR_SERVER_IP:4317` |

For apps on the same server, the internal mode is preferred — no exposed port required and slightly lower latency.

---

## Step 1 — Connect to the observability network (same server only)

Copy the relevant blocks from `compose-snippet.yml` into your app's `docker-compose.yml`:

```yaml
# Top-level networks block
networks:
  observability:
    external: true
    name: observability

# Per-service additions
services:
  your-app:
    networks:
      - default
      - observability   # ← add this
    environment:
      - OTEL_SERVICE_NAME=your-app-name
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
      - OTEL_TRACES_EXPORTER=otlp
      - OTEL_METRICS_EXPORTER=otlp
      - OTEL_LOGS_EXPORTER=otlp
      - SENTRY_DSN=http://KEY@errors.yourdomain.com/PROJECT_ID
```

> The observability stack must be **deployed first** to create the `observability` network. Redeploy your app after that.

---

## Step 2 — Add the SDK to your app

### Node.js — NestJS / Express

```bash
npm install \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-grpc \
  @opentelemetry/exporter-metrics-otlp-grpc \
  @opentelemetry/exporter-logs-otlp-grpc \
  @opentelemetry/sdk-metrics \
  @opentelemetry/sdk-logs \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions \
  @sentry/node
```

Copy `node/instrumentation.ts` into your project root, then:

```typescript
// main.ts — import FIRST, before anything else
import './instrumentation';
import { NestFactory } from '@nestjs/core';
// ...
```

---

### Next.js

```bash
npm install \
  @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions \
  @sentry/nextjs
```

Copy `node/next.instrumentation.ts` into your project root as `instrumentation.ts`.

```ts
// next.config.ts
export default {
  experimental: {
    instrumentationHook: true,   // not needed in Next.js 15+
  },
};
```

---

### Python — Django / FastAPI

```bash
pip install \
  opentelemetry-sdk \
  opentelemetry-exporter-otlp-proto-grpc \
  opentelemetry-instrumentation-django \
  opentelemetry-instrumentation-fastapi \
  opentelemetry-instrumentation-sqlalchemy \
  opentelemetry-instrumentation-psycopg2 \
  opentelemetry-instrumentation-redis \
  opentelemetry-instrumentation-httpx \
  opentelemetry-instrumentation-requests \
  "sentry-sdk[django]"
```

Copy `python/otel.py` into your project, then:

```python
# manage.py (Django) — add before os.environ.setdefault(...)
from otel import setup_django_otel
setup_django_otel()

# main.py (FastAPI) — add after app = FastAPI()
from otel import setup_fastapi_otel
setup_fastapi_otel(app)
```

**Or use the CLI agent (zero code changes):**

```bash
opentelemetry-instrument uvicorn main:app --host 0.0.0.0 --port 8000
opentelemetry-instrument python manage.py runserver
```

---

### Go

```bash
go get \
  go.opentelemetry.io/otel \
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc \
  go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc \
  go.opentelemetry.io/otel/sdk/trace \
  go.opentelemetry.io/otel/sdk/metric \
  go.opentelemetry.io/otel/sdk/resource \
  go.opentelemetry.io/semconv/v1.26.0 \
  go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp \
  github.com/getsentry/sentry-go
```

Copy `go/otel.go` into your project as `internal/otelsetup/otel.go`, then:

```go
// main.go
shutdown, err := otelsetup.Init(context.Background())
if err != nil { log.Fatal(err) }
defer shutdown(context.Background())

// Wrap handlers:
http.Handle("/api/", otelhttp.NewHandler(handler, "api.handler"))
```

---

### Rust

Add to `Cargo.toml`:

```toml
[dependencies]
opentelemetry             = { version = "0.22", features = ["trace", "metrics"] }
opentelemetry-otlp        = { version = "0.15", features = ["grpc-tonic", "metrics"] }
opentelemetry_sdk         = { version = "0.22", features = ["rt-tokio"] }
opentelemetry-semantic-conventions = "0.14"
tracing                   = "0.1"
tracing-opentelemetry     = "0.23"
tracing-subscriber        = { version = "0.3", features = ["env-filter", "json"] }
sentry                    = "0.32"
```

Copy `rust/otel.rs` into your project as `src/otel.rs`, then:

```rust
// main.rs
mod otel;

#[tokio::main]
async fn main() {
    let _guard = otel::init().expect("OTel init failed");
    // your app — _guard flushes telemetry on drop
}
```

---

## Environment variables reference

Copy from `.env.otel` and set these in Coolify's Environment Variables panel for each service.

| Variable | Required | Example |
|----------|----------|---------|
| `OTEL_SERVICE_NAME` | ✓ | `kindlepath-api` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ✓ | `http://otel-collector:4317` |
| `OTEL_TRACES_EXPORTER` | ✓ | `otlp` |
| `OTEL_METRICS_EXPORTER` | | `otlp` |
| `OTEL_LOGS_EXPORTER` | | `otlp` |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | | `production` |
| `OTEL_SERVICE_VERSION` | | `1.2.0` |
| `OTEL_TRACES_SAMPLER_ARG` | | `1.0` (100%) |
| `OTEL_RESOURCE_ATTRIBUTES` | | `team=backend,project=arinex` |
| `SENTRY_DSN` | | `http://KEY@errors.yourdomain.com/1` |

---

## Viewing your apps in Grafana

After deploying with OTel SDK:

1. Open Grafana → **Explore → Loki**
   - Filter: `{service="your-app-name"}`

2. Open Grafana → **Explore → Tempo**
   - Search by service name or filter by `service.name = your-app-name`

3. Open Grafana → **Explore → Prometheus**
   - Query: `{service_name="your-app-name"}`

4. **Dashboards → Import** → use these IDs for pre-built multi-service views:
   - `13639` — Node.js service metrics
   - `16098` — Tempo service graph (shows all services and their connections)
   - `15141` — NestJS overview
   - `14282` — Loki log browser

5. Create a Grafana variable for service selection:
   - Dashboards → Edit → Variables → Add variable
   - Name: `service`, Type: Query, Data source: Prometheus
   - Query: `label_values(traces_spanmetrics_calls_total, service_name)`
   - This gives you a dropdown to switch between all instrumented apps.
