"""
sdk/python/otel.py
─────────────────────────────────────────────────────────────
OpenTelemetry instrumentation for Django and FastAPI.
Covers traces, metrics, and structured logging.

INSTALL:
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
    sentry-sdk[django]  # or sentry-sdk[fastapi]

USAGE — Django:
  Call setup_django_otel() at the top of manage.py or wsgi.py
  before Django is loaded.

  # manage.py
  from otel import setup_django_otel
  setup_django_otel()

USAGE — FastAPI:
  Call setup_fastapi_otel(app) after creating the FastAPI instance.

  # main.py
  from fastapi import FastAPI
  from otel import setup_fastapi_otel

  app = FastAPI()
  setup_fastapi_otel(app)

USAGE — Auto-instrument CLI (no code changes):
  OTEL_SERVICE_NAME=my-service \\
  OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317 \\
  opentelemetry-instrument python manage.py runserver

  OTEL_SERVICE_NAME=my-service \\
  OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317 \\
  opentelemetry-instrument uvicorn main:app --host 0.0.0.0 --port 8000

ENV VARS (set in .env or Coolify UI):
  OTEL_SERVICE_NAME               my-django-service
  OTEL_EXPORTER_OTLP_ENDPOINT    http://otel-collector:4317
  OTEL_DEPLOYMENT_ENVIRONMENT    production
  SENTRY_DSN                      http://KEY@errors.yourdomain.com/PROJECT_ID
─────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
import os

# ── Config ────────────────────────────────────────────────────
SERVICE_NAME  = os.getenv("OTEL_SERVICE_NAME", "python-service")
ENDPOINT      = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4317")
ENVIRONMENT   = os.getenv("OTEL_DEPLOYMENT_ENVIRONMENT", "production")
SAMPLE_RATE   = float(os.getenv("OTEL_TRACES_SAMPLER_ARG", "1.0"))
SENTRY_DSN    = os.getenv("SENTRY_DSN") or os.getenv("GLITCHTIP_DSN")


def _build_provider():
    """Create and register the OTel TracerProvider."""
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource, SERVICE_NAME as RESOURCE_SERVICE_NAME
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

    resource = Resource.create(
        {
            RESOURCE_SERVICE_NAME: SERVICE_NAME,
            "deployment.environment": ENVIRONMENT,
            "service.version": os.getenv("SERVICE_VERSION", "0.0.0"),
        }
    )

    sampler = ParentBased(root=TraceIdRatioBased(SAMPLE_RATE))
    provider = TracerProvider(resource=resource, sampler=sampler)
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=ENDPOINT, insecure=True))
    )
    trace.set_tracer_provider(provider)
    return provider


def _setup_sentry():
    """Initialize GlitchTip/Sentry error tracking."""
    if not SENTRY_DSN:
        return
    try:
        import sentry_sdk
        sentry_sdk.init(
            dsn=SENTRY_DSN,
            environment=ENVIRONMENT,
            # Tracing handled by OTel — disable Sentry's own tracing
            traces_sample_rate=0.0,
            # Still capture unhandled exceptions and performance issues
            profiles_sample_rate=0.0,
        )
        logging.getLogger(__name__).info("[GlitchTip] ✓ error tracking initialized")
    except ImportError:
        logging.getLogger(__name__).warning("[GlitchTip] sentry-sdk not installed — skipping")


# ── Django ────────────────────────────────────────────────────

def setup_django_otel() -> None:
    """
    Initialize OTel for a Django application.

    Call this at the very top of manage.py or wsgi.py,
    before Django settings are loaded.

    Example (manage.py):
        from otel import setup_django_otel
        setup_django_otel()
        os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'myproject.settings')
        ...
    """
    _build_provider()

    # Auto-instrument everything Django touches
    _instrument_shared()

    try:
        from opentelemetry.instrumentation.django import DjangoInstrumentor
        DjangoInstrumentor().instrument(is_sql_commentor_enabled=True)
    except ImportError:
        pass

    _setup_sentry()

    logging.basicConfig(level=logging.INFO)
    logging.getLogger(__name__).info(
        "[OTel] ✓ Django instrumented — service: %s → %s", SERVICE_NAME, ENDPOINT
    )


# ── FastAPI ───────────────────────────────────────────────────

def setup_fastapi_otel(app) -> None:
    """
    Initialize OTel for a FastAPI application.

    Call this after creating your FastAPI() instance.

    Example (main.py):
        from fastapi import FastAPI
        from otel import setup_fastapi_otel

        app = FastAPI()
        setup_fastapi_otel(app)
    """
    _build_provider()
    _instrument_shared()

    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        FastAPIInstrumentor.instrument_app(
            app,
            # Exclude noisy health check endpoints from traces
            excluded_urls=r"health|healthz|ready|metrics",
        )
    except ImportError:
        pass

    _setup_sentry()

    logging.getLogger(__name__).info(
        "[OTel] ✓ FastAPI instrumented — service: %s → %s", SERVICE_NAME, ENDPOINT
    )


# ── Shared instrumentations ───────────────────────────────────

def _instrument_shared() -> None:
    """Auto-instrument libraries shared across Django and FastAPI."""

    # SQLAlchemy / Django ORM (via psycopg2)
    _try_instrument("opentelemetry.instrumentation.sqlalchemy", "SQLAlchemyInstrumentor")
    _try_instrument("opentelemetry.instrumentation.psycopg2", "Psycopg2Instrumentor")

    # HTTP clients
    _try_instrument("opentelemetry.instrumentation.requests", "RequestsInstrumentor")
    _try_instrument("opentelemetry.instrumentation.httpx",    "HTTPXClientInstrumentor")
    _try_instrument("opentelemetry.instrumentation.aiohttp_client", "AioHttpClientInstrumentor")

    # Caching and queues
    _try_instrument("opentelemetry.instrumentation.redis",    "RedisInstrumentor")
    _try_instrument("opentelemetry.instrumentation.celery",   "CeleryInstrumentor")


def _try_instrument(module_path: str, class_name: str) -> None:
    try:
        import importlib
        mod = importlib.import_module(module_path)
        instrumentor = getattr(mod, class_name)()
        instrumentor.instrument()
    except (ImportError, Exception):
        pass  # silently skip if the library isn't installed


# ── Structured logging helper ─────────────────────────────────

def get_logger(name: str) -> logging.Logger:
    """
    Returns a logger that automatically injects the current
    trace_id and span_id into log records.

    Every log line emitted with this logger will be correlated
    with the active trace in Grafana → Loki → Tempo.

    Usage:
        from otel import get_logger
        logger = get_logger(__name__)
        logger.info("User created", extra={"user_id": 123})
    """
    from opentelemetry import trace as otel_trace

    class OTelFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
            span = otel_trace.get_current_span()
            ctx = span.get_span_context()
            record.trace_id = format(ctx.trace_id, "032x") if ctx.trace_id else ""
            record.span_id  = format(ctx.span_id, "016x")  if ctx.span_id  else ""
            record.service  = SERVICE_NAME
            return True

    logger = logging.getLogger(name)
    if not any(isinstance(f, OTelFilter) for f in logger.filters):
        logger.addFilter(OTelFilter())
    return logger


# ── Custom metrics helper ─────────────────────────────────────

def get_meter(name: str):
    """
    Returns an OTel Meter for recording custom business metrics.

    Usage:
        from otel import get_meter

        meter = get_meter("payments")
        tx_counter = meter.create_counter(
            "payments.transactions.total",
            description="Total payment transactions",
        )

        # In your payment handler:
        tx_counter.add(1, {"status": "success", "currency": "NGN"})
    """
    from opentelemetry import metrics
    return metrics.get_meter(name)
