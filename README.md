# Observability Stack

Self-hosted observability for all your services — metrics, logs, traces, error tracking, and uptime monitoring — deployed as a single stack on your Coolify server.

## What's included

| Service | Role | Access |
|---------|------|--------|
| **OpenTelemetry Collector** | Receives all telemetry from every app, routes to backends | `4317` gRPC · `4318` HTTP (host ports) |
| **Prometheus** | Metrics storage + PromQL | internal |
| **Loki** | Log aggregation + LogQL | internal |
| **Tempo** | Distributed traces | internal |
| **Grafana** | Dashboards, alerting, on-call | your domain |
| **GlitchTip** | Error tracking — Sentry-compatible SDKs work as-is | your domain |
| **Uptime Kuma** | HTTP uptime checks + public status page | your domain |

---

## How apps connect

```
┌──────────────────────────────────────────────────┐
│                  Hetzner VPS                     │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │          observability Docker network        │ │
│  │                                             │ │
│  │  ┌──────────┐    ┌──────────────────────┐  │ │
│  │  │ your-app │───▶│  otel-collector:4317 │  │ │
│  │  │ (NestJS) │    └──────────────────────┘  │ │
│  │  └──────────┘             │                │ │
│  │                    ┌──────┴──────┐          │ │
│  │             Prometheus  Loki  Tempo          │ │
│  │                    └──────┬──────┘          │ │
│  │                        Grafana              │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  External apps → SERVER_IP:4317 (host port)       │
└──────────────────────────────────────────────────┘
```

**Internal** (same server, Docker network) → `http://otel-collector:4317`
**External** (any server) → `http://YOUR_SERVER_IP:4317`

See `sdk/README.md` for full setup instructions per language.

---

## Deploy on Coolify

### 1. Fork this repo

Click **Fork** at the top of [this repository](https://github.com/nabdulhaleem/observability-stack) on GitHub.

### 2. Add to Coolify

1. Coolify dashboard → your project → **New Resource → Application**
2. Source: **GitHub** → select this repo
3. Build Pack: **Docker Compose**
4. Compose file location: `/docker-compose.yaml`

### 3. Set environment variables

| Variable | Value |
|----------|-------|
| `GRAFANA_ADMIN_PASSWORD` | strong password |
| `GRAFANA_ROOT_URL` | `https://grafana.yourdomain.com` |
| `GLITCHTIP_SECRET_KEY` | output of `python3 -c "import secrets; print(secrets.token_hex(50))"` |
| `GLITCHTIP_DB_PASSWORD` | strong password |
| `GLITCHTIP_DOMAIN` | `https://errors.yourdomain.com` |

### 4. Assign domains

| Service | Example domain | Port |
|---------|---------------|------|
| `grafana` | `grafana.yourdomain.com` | `3000` |
| `glitchtip-web` | `errors.yourdomain.com` | `8000` |
| `uptime-kuma` | `status.yourdomain.com` | `3001` |

In Coolify's domain field, include the port: `https://grafana.yourdomain.com:3000`

### 5. Deploy

Click **Deploy**. First boot takes ~2 minutes as Loki and Tempo initialize.

---

## Troubleshooting

### "not a directory" mount error on first deploy

**Symptom:** Coolify logs show:
```
error mounting ".../config/prometheus.yml" ... not a directory
```

**Cause:** Coolify's Docker Compose deployment pre-creates missing bind-mount sources as directories before the git clone runs. If a config file path doesn't exist yet, Docker creates a directory there — then git can't replace that directory with the actual file.

**This is fixed in the compose file** — all configs now mount the whole `./config/` directory (which Docker correctly pre-creates as a directory) and each service is pointed to its file via a `--config.file=` flag. If you were running an older version of this stack, pull the latest and redeploy.

---

## After deploying — first-time setup

### Grafana

1. Log in at your Grafana domain with `admin` / your password
2. Data sources (Prometheus, Loki, Tempo) are already provisioned and linked
3. Import dashboards via **Dashboards → Import**:
   - `3662` — Prometheus stats
   - `13639` — Node.js / NestJS metrics
   - `16098` — Tempo service graph (see all your services and connections)
   - `14282` — Loki log browser

### GlitchTip

1. Open your GlitchTip domain → **Register** (first account becomes admin)
2. Create an Organization and a Project for each app
3. Copy the **DSN** from project settings → add as `SENTRY_DSN` env var in each app

### Uptime Kuma

1. Open your Uptime Kuma domain → create admin account on first visit
2. Add monitors for all your service endpoints
3. **Settings → Notifications → Telegram** — add your bot token and chat ID

---

## Connecting your apps

See `sdk/README.md` for the full guide.

Quick version — add to each app's Coolify environment variables:

```bash
OTEL_SERVICE_NAME=my-app-name
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317    # internal
# or
OTEL_EXPORTER_OTLP_ENDPOINT=http://YOUR_SERVER_IP:4317   # external
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
SENTRY_DSN=http://KEY@errors.yourdomain.com/PROJECT_ID
```

And add to each app's `docker-compose.yaml` (for internal network access):

```yaml
networks:
  observability:
    external: true
    name: observability

services:
  my-app:
    networks:
      - default
      - observability
```

---

## Folder structure

```
observability-stack/
├── docker-compose.yaml
├── .env.example
├── .gitignore
├── README.md
├── config/
│   ├── otel-collector.yaml         OTel routing config
│   ├── prometheus.yml              scrape config
│   ├── loki.yaml                   log retention config
│   ├── tempo.yaml                  trace storage config
│   └── grafana/
│       └── provisioning/
│           ├── datasources/        auto-wires Prometheus + Loki + Tempo
│           └── dashboards/         drop JSON files here to import dashboards
└── sdk/
    ├── README.md                   SDK integration guide
    ├── compose-snippet.yml         copy → paste into your app's compose
    ├── .env.otel                   copy → paste into your app's env vars
    ├── node/
    │   ├── instrumentation.ts      NestJS / Express
    │   └── next.instrumentation.ts Next.js (App Router)
    ├── python/
    │   └── otel.py                 Django + FastAPI
    ├── go/
    │   └── otel.go                 Go services
    └── rust/
        └── otel.rs                 Rust / Tokio / Axum / Actix
```

---

## Estimated resource usage

| Service | RAM |
|---------|-----|
| OTel Collector | ~100 MB |
| Prometheus | ~200 MB |
| Loki | ~200 MB |
| Tempo | ~300 MB |
| Grafana | ~200 MB |
| GlitchTip (web + worker + db + redis) | ~600 MB |
| Uptime Kuma | ~100 MB |
| **Total** | **~1.7 GB** |

Comfortable on a Hetzner CX31 (8 GB RAM, ~€10/mo) alongside your apps.

---

## Ports reference

| Port | Exposed to | Purpose |
|------|-----------|---------|
| `4317` | Host | OTel Collector — gRPC (apps send traces/metrics/logs here) |
| `4318` | Host | OTel Collector — HTTP (Next.js / edge runtime) |
| `3000` | Traefik | Grafana dashboard |
| `8000` | Traefik | GlitchTip error tracker |
| `3001` | Traefik | Uptime Kuma status page |
| `9090` | Internal | Prometheus (internal only) |
| `3100` | Internal | Loki (internal only) |
| `3200` | Internal | Tempo (internal only) |
