// sdk/rust/otel.rs
// ─────────────────────────────────────────────────────────────
// OpenTelemetry setup for Rust services using Tokio async runtime.
// Integrates with the `tracing` ecosystem for structured logging.
//
// CARGO.TOML DEPENDENCIES:
//   [dependencies]
//   opentelemetry             = { version = "0.22", features = ["trace", "metrics"] }
//   opentelemetry-otlp        = { version = "0.15", features = ["grpc-tonic", "metrics"] }
//   opentelemetry_sdk         = { version = "0.22", features = ["rt-tokio"] }
//   opentelemetry-semantic-conventions = "0.14"
//   tracing                   = "0.1"
//   tracing-opentelemetry     = "0.23"
//   tracing-subscriber        = { version = "0.3", features = ["env-filter", "json"] }
//   tokio                     = { version = "1", features = ["full"] }
//   tonic                     = "0.11"
//   sentry                    = { version = "0.32", features = ["tracing"] }  # optional
//
// USAGE:
//   #[tokio::main]
//   async fn main() {
//       let _guard = otel::init().expect("OTel init failed");
//       // your app here
//       // _guard dropped on exit → flushes telemetry
//   }
//
// ENV VARS:
//   OTEL_SERVICE_NAME              my-rust-service
//   OTEL_EXPORTER_OTLP_ENDPOINT   http://otel-collector:4317
//   OTEL_DEPLOYMENT_ENVIRONMENT   production
//   SENTRY_DSN                     http://KEY@errors.yourdomain.com/1
//   RUST_LOG                       info   (controls tracing subscriber level)
// ─────────────────────────────────────────────────────────────

use opentelemetry::{global, KeyValue};
use opentelemetry_otlp::{ExportConfig, WithExportConfig};
use opentelemetry_sdk::{
    metrics::{MeterProviderBuilder, PeriodicReader},
    runtime,
    trace::{BatchConfig, RandomIdGenerator, Sampler, TracerProvider},
    Resource,
};
use opentelemetry_semantic_conventions::{
    resource::{DEPLOYMENT_ENVIRONMENT, SERVICE_NAME, SERVICE_VERSION},
    SCHEMA_URL,
};
use std::env;
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Guard that shuts down OTel providers on drop.
/// Keep this alive for the lifetime of your application.
///
/// ```rust
/// #[tokio::main]
/// async fn main() {
///     let _guard = otel::init().expect("OTel init failed");
///     // your application runs here
///     // _guard is dropped at end of main → flushes all telemetry
/// }
/// ```
pub struct OtelGuard {
    tracer_provider: TracerProvider,
}

impl Drop for OtelGuard {
    fn drop(&mut self) {
        if let Err(e) = self.tracer_provider.shutdown() {
            eprintln!("[OTel] Tracer shutdown error: {e}");
        }
        global::shutdown_tracer_provider();
    }
}

/// Initialize OpenTelemetry traces, metrics, and structured logging.
/// Returns an OtelGuard — keep it alive until your process exits.
pub fn init() -> Result<OtelGuard, Box<dyn std::error::Error + Send + Sync>> {
    let service_name    = env_or("OTEL_SERVICE_NAME",             "rust-service");
    let service_version = env_or("SERVICE_VERSION",               "0.0.0");
    let environment     = env_or("OTEL_DEPLOYMENT_ENVIRONMENT",   "production");
    let endpoint        = env_or("OTEL_EXPORTER_OTLP_ENDPOINT",  "http://otel-collector:4317");

    // ── Shared resource ───────────────────────────────────────
    let resource = Resource::from_schema_url(
        [
            KeyValue::new(SERVICE_NAME,             service_name.clone()),
            KeyValue::new(SERVICE_VERSION,          service_version),
            KeyValue::new(DEPLOYMENT_ENVIRONMENT,   environment.clone()),
        ],
        SCHEMA_URL,
    );

    // ── Tracer provider ───────────────────────────────────────
    let export_config = ExportConfig {
        endpoint: endpoint.clone(),
        ..Default::default()
    };

    let tracer_provider = opentelemetry_otlp::new_pipeline()
        .tracing()
        .with_exporter(
            opentelemetry_otlp::new_exporter()
                .tonic()
                .with_export_config(export_config.clone()),
        )
        .with_trace_config(
            opentelemetry_sdk::trace::Config::default()
                .with_sampler(Sampler::AlwaysOn)
                .with_id_generator(RandomIdGenerator::default())
                .with_resource(resource.clone()),
        )
        .with_batch_config(BatchConfig::default())
        .install_batch(runtime::Tokio)?;

    global::set_tracer_provider(tracer_provider.clone());

    // ── Metric provider ───────────────────────────────────────
    let metric_exporter = opentelemetry_otlp::new_exporter()
        .tonic()
        .with_export_config(export_config)
        .build_metrics_exporter(
            Box::new(opentelemetry_sdk::metrics::reader::DefaultTemporalitySelector::new()),
            Box::new(opentelemetry_sdk::metrics::reader::DefaultAggregationSelector::new()),
        )?;

    let meter_provider = MeterProviderBuilder::default()
        .with_resource(resource)
        .with_reader(
            PeriodicReader::builder(metric_exporter, runtime::Tokio)
                .with_interval(std::time::Duration::from_secs(30))
                .build(),
        )
        .build();

    global::set_meter_provider(meter_provider);

    // ── Tracing subscriber (structured logging + OTel spans) ──
    // Reads log level from RUST_LOG env var (e.g. RUST_LOG=info,my_crate=debug)
    let tracer = global::tracer(service_name.clone());
    let otel_layer = OpenTelemetryLayer::new(tracer);

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(
            // JSON structured logs for Loki ingestion
            tracing_subscriber::fmt::layer().json(),
        )
        .with(otel_layer)
        .init();

    // ── GlitchTip / Sentry ────────────────────────────────────
    // Uncomment after adding `sentry = "0.32"` to Cargo.toml:
    //
    // let _sentry_guard = sentry::init((
    //     std::env::var("SENTRY_DSN").unwrap_or_default(),
    //     sentry::ClientOptions {
    //         environment: Some(environment.into()),
    //         traces_sample_rate: 0.0, // tracing handled by OTel
    //         ..Default::default()
    //     },
    // ));

    tracing::info!(
        service = %service_name,
        endpoint = %endpoint,
        "[OTel] ✓ instrumentation initialized"
    );

    Ok(OtelGuard { tracer_provider })
}

/// Convenience: get a named meter for custom business metrics.
///
/// ```rust
/// let meter = otel::meter("payments");
/// let counter = meter.u64_counter("payments.total").init();
/// counter.add(1, &[KeyValue::new("currency", "NGN")]);
/// ```
pub fn meter(name: &'static str) -> opentelemetry::metrics::Meter {
    global::meter(name)
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_owned())
}

// ─────────────────────────────────────────────────────────────
// AXUM INTEGRATION EXAMPLE
// ─────────────────────────────────────────────────────────────
//
// Add to Cargo.toml:
//   tower-http = { version = "0.5", features = ["trace"] }
//
// In main.rs:
//
// use tower_http::trace::TraceLayer;
// use axum::Router;
//
// let app = Router::new()
//     .route("/api/users", get(list_users))
//     .layer(TraceLayer::new_for_http());
//
// ─────────────────────────────────────────────────────────────
// ACTIX-WEB INTEGRATION EXAMPLE
// ─────────────────────────────────────────────────────────────
//
// Add to Cargo.toml:
//   actix-web-opentelemetry = "0.18"
//
// In main.rs:
//
// use actix_web_opentelemetry::RequestTracing;
//
// App::new()
//     .wrap(RequestTracing::new())
//     .service(...)
// ─────────────────────────────────────────────────────────────
