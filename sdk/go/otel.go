// sdk/go/otel.go
// ─────────────────────────────────────────────────────────────
// OpenTelemetry setup for Go services.
// Initializes traces, metrics, and structured logging via the
// OTel SDK with OTLP gRPC export to the collector.
//
// INSTALL:
//   go get go.opentelemetry.io/otel \
//     go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc \
//     go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc \
//     go.opentelemetry.io/otel/sdk/trace \
//     go.opentelemetry.io/otel/sdk/metric \
//     go.opentelemetry.io/otel/sdk/resource \
//     go.opentelemetry.io/semconv/v1.26.0 \
//     go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp \
//     go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc
//
// USAGE:
//   shutdown, err := otelsetup.Init(context.Background())
//   if err != nil { log.Fatal(err) }
//   defer shutdown(context.Background())
//
//   // Wrap your HTTP handler:
//   http.Handle("/api/", otelhttp.NewHandler(myHandler, "api"))
//
// ENV VARS:
//   OTEL_SERVICE_NAME              my-go-service
//   OTEL_EXPORTER_OTLP_ENDPOINT   http://otel-collector:4317
//   OTEL_DEPLOYMENT_ENVIRONMENT   production
//   SENTRY_DSN                     http://KEY@errors.yourdomain.com/1
// ─────────────────────────────────────────────────────────────

package otelsetup

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// ShutdownFunc flushes and closes all OTel providers.
// Defer this in main() after calling Init().
type ShutdownFunc func(ctx context.Context) error

// Init sets up OTel trace and metric providers.
// Returns a shutdown function to call on graceful exit.
//
// Example (main.go):
//
//	func main() {
//	    ctx := context.Background()
//	    shutdown, err := otelsetup.Init(ctx)
//	    if err != nil { log.Fatal(err) }
//	    defer func() {
//	        if err := shutdown(ctx); err != nil {
//	            log.Printf("OTel shutdown error: %v", err)
//	        }
//	    }()
//	    // ... start your server
//	}
func Init(ctx context.Context) (ShutdownFunc, error) {
	endpoint := getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "otel-collector:4317")
	// Strip any scheme prefix — gRPC uses bare host:port
	endpoint = stripScheme(endpoint)

	serviceName    := getenv("OTEL_SERVICE_NAME",             "go-service")
	serviceVersion := getenv("SERVICE_VERSION",               "0.0.0")
	environment    := getenv("OTEL_DEPLOYMENT_ENVIRONMENT",   "production")

	// ── Resource ───────────────────────────────────────────────
	res, err := resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(serviceName),
			semconv.ServiceVersion(serviceVersion),
			semconv.DeploymentEnvironment(environment),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("otel: build resource: %w", err)
	}

	// ── gRPC connection ────────────────────────────────────────
	conn, err := grpc.NewClient(
		endpoint,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("otel: gRPC dial %s: %w", endpoint, err)
	}

	// ── Trace provider ─────────────────────────────────────────
	traceExporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, fmt.Errorf("otel: trace exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithBatcher(traceExporter,
			sdktrace.WithBatchTimeout(time.Second),
		),
		// Adjust sample rate via OTEL_TRACES_SAMPLER_ARG env var in the collector
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)
	otel.SetTracerProvider(tp)

	// ── Metric provider ────────────────────────────────────────
	metricExporter, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, fmt.Errorf("otel: metric exporter: %w", err)
	}

	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(
			sdkmetric.NewPeriodicReader(metricExporter,
				sdkmetric.WithInterval(30*time.Second),
			),
		),
	)
	otel.SetMeterProvider(mp)

	// ── Propagation (W3C TraceContext + Baggage) ───────────────
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	log.Printf("[OTel] ✓ %s@%s → %s | env: %s", serviceName, serviceVersion, endpoint, environment)

	// ── GlitchTip (Sentry-compatible) ─────────────────────────
	initSentry()

	// ── Shutdown function ──────────────────────────────────────
	return func(ctx context.Context) error {
		var errs []error
		if err := tp.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
		if err := mp.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
		if err := conn.Close(); err != nil {
			errs = append(errs, err)
		}
		if len(errs) > 0 {
			return fmt.Errorf("otel shutdown errors: %v", errs)
		}
		return nil
	}, nil
}

// Tracer returns a named tracer from the global provider.
// Use this to create spans in your application code.
//
//	tracer := otelsetup.Tracer("payments")
//	ctx, span := tracer.Start(ctx, "process-payment")
//	defer span.End()
func Tracer(name string) interface{ Start(ctx context.Context, spanName string, opts ...interface{}) (context.Context, interface{}) } {
	return otel.Tracer(name)
}

// Meter returns a named meter from the global provider.
// Use this to create custom counters, histograms, and gauges.
//
//	meter := otelsetup.Meter("api")
//	reqCount, _ := meter.Int64Counter("api.requests.total")
//	reqCount.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/users")))
func Meter(name string) interface{} {
	return otel.Meter(name)
}

func initSentry() {
	// Install: go get github.com/getsentry/sentry-go
	//
	// dsn := os.Getenv("SENTRY_DSN")
	// if dsn == "" { return }
	// if err := sentry.Init(sentry.ClientOptions{
	//     Dsn:              dsn,
	//     Environment:      os.Getenv("OTEL_DEPLOYMENT_ENVIRONMENT"),
	//     TracesSampleRate: 0, // tracing handled by OTel
	// }); err != nil {
	//     log.Printf("[GlitchTip] init error: %v", err)
	//     return
	// }
	// defer sentry.Flush(2 * time.Second)
	// log.Println("[GlitchTip] ✓ error tracking initialized")
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func stripScheme(endpoint string) string {
	for _, prefix := range []string{"http://", "https://", "grpc://"} {
		if len(endpoint) > len(prefix) && endpoint[:len(prefix)] == prefix {
			return endpoint[len(prefix):]
		}
	}
	return endpoint
}
