import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/**
 * A throwaway in-memory OpenTelemetry SDK, for the integration scenario that
 * checks a trace context really crosses a real broker.
 *
 * Registered per test and torn down straight after: the API keeps its provider
 * on `globalThis`, and the integration specs share one process (`maxWorkers: 1`).
 */
export interface TracingProbe {
  /** Trace id of the span the publish happened under. */
  readonly traceId: string;
  /** Publish (or anything else) inside a recorded parent span. */
  run<T>(fn: () => T): T;
  /** Names of the spans the library emitted, in completion order. */
  spanNames(): string[];
  /** Unregister the SDK — always call it, in a `finally`. */
  disable(): void;
}

export function enableTracing(): TracingProbe {
  const exporter = new InMemorySpanExporter();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );

  const parent = trace.getTracer('integration').startSpan('caller');
  return {
    traceId: parent.spanContext().traceId,
    run<T>(fn: () => T): T {
      return context.with(trace.setSpan(context.active(), parent), fn);
    },
    spanNames(): string[] {
      return exporter.getFinishedSpans().map((s) => s.name);
    },
    disable(): void {
      parent.end();
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}
