import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Link,
  type Span,
} from '@opentelemetry/api';
import type { BrokerBrand } from './broker-connection';

/**
 * Native OpenTelemetry instrumentation — the whole of it.
 *
 * ## Why it lives here
 *
 * There is no `@opentelemetry/instrumentation-rhea` on npm, and
 * `instrumentation-amqplib` only covers AMQP 0.9.1. Nothing outside this
 * package can ever trace it, which is exactly the case OpenTelemetry
 * describes as a *natively instrumented library*: the library ships its own
 * instrumentation.
 *
 * ## Why there is no configuration
 *
 * The module depends on `@opentelemetry/api` alone — never the SDK, never an
 * exporter. The API is inert on its own: with no SDK registered by the host
 * application, `trace.getTracer()` returns a no-op tracer whose spans carry an
 * invalid span context, and `propagation.inject()` writes **nothing** (it
 * returns early on an invalid context). So the code below is unconditional —
 * no flag, no environment variable, no option. "Optional" means the
 * application decides by registering an SDK or not; the endpoint, the sampler
 * and the service name belong to the application, never to this library.
 *
 * Sampling is inherited, never forced. A host running
 * `parentbased_always_off` — where a single gateway starts every trace — keeps
 * that invariant: these spans are children of whatever is active, so they
 * follow the decision already made upstream.
 *
 * ## Attribute names
 *
 * Messaging semantic conventions are still in *development* status upstream,
 * so the names are inlined as literals rather than pulled from
 * `@opentelemetry/semantic-conventions` (which would add a dependency for a
 * handful of strings, and which the spec itself says not to chase until the
 * conventions go stable).
 */

/** Instrumentation scope reported on every span this library emits. */
const TRACER_NAME = '@softwarity/nestjs-amqp';

/** Messaging semantic-convention attribute names (semconv messaging spans). */
const ATTR_SYSTEM = 'messaging.system';
const ATTR_DESTINATION = 'messaging.destination.name';
const ATTR_OPERATION_NAME = 'messaging.operation.name';
const ATTR_OPERATION_TYPE = 'messaging.operation.type';
const ATTR_MESSAGE_ID = 'messaging.message.id';
const ATTR_CONVERSATION_ID = 'messaging.message.conversation_id';
const ATTR_ERROR_TYPE = 'error.type';

/** The W3C header this library propagates through `application_properties`. */
const TRACEPARENT = 'traceparent';

/**
 * `messaging.system` for the peer we're talking to, derived from the brand
 * already detected on the AMQP Open frame. The semantic conventions define no
 * well-known value for AMQP 1.0, Artemis or Qpid: Artemis *is* ActiveMQ, so it
 * reports `activemq`; Qpid and unrecognised peers get a plain value (the
 * attribute is an open enumeration).
 */
export function messagingSystem(brand: BrokerBrand): string {
  switch (brand) {
    case 'rabbitmq':
      return 'rabbitmq';
    case 'artemis':
      return 'activemq';
    case 'qpid':
      return 'qpid';
    default:
      return 'amqp';
  }
}

/** Shared attribute set for one messaging span. */
interface SpanAttrs {
  readonly address: string;
  readonly brand: BrokerBrand;
  /** `messaging.operation.name` — required by the conventions. */
  readonly operationName: 'send' | 'receive' | 'process';
  /** `messaging.operation.type` — the phase this span describes. */
  readonly operationType: 'send' | 'receive' | 'process';
  readonly messageId?: unknown;
  readonly conversationId?: unknown;
}

function attributesOf(a: SpanAttrs): Record<string, string> {
  const attrs: Record<string, string> = {
    [ATTR_SYSTEM]: messagingSystem(a.brand),
    [ATTR_DESTINATION]: a.address,
    [ATTR_OPERATION_NAME]: a.operationName,
    [ATTR_OPERATION_TYPE]: a.operationType,
  };
  if (a.messageId !== undefined && a.messageId !== null) attrs[ATTR_MESSAGE_ID] = String(a.messageId);
  if (a.conversationId !== undefined && a.conversationId !== null) {
    attrs[ATTR_CONVERSATION_ID] = String(a.conversationId);
  }
  return attrs;
}

/**
 * Start a span for one messaging operation. The name follows the convention
 * `{messaging.operation.name} {destination}` — `send orders.create`,
 * `process orders.create`.
 *
 * `parent` defaults to the active context, which is how a publish becomes a
 * child of the HTTP span that triggered it with nothing to pass explicitly:
 * the SDK's context manager (AsyncLocalStorage) carries it.
 */
export function startMessagingSpan(
  a: SpanAttrs & { kind: SpanKind; links?: Link[]; parent?: Context },
): Span {
  return trace
    .getTracer(TRACER_NAME)
    .startSpan(
      `${a.operationName} ${a.address}`,
      { kind: a.kind, attributes: attributesOf(a), links: a.links },
      a.parent ?? context.active(),
    );
}

/**
 * Write the active trace context into an outgoing message's
 * `application_properties`, **unless the carrier already has one**.
 *
 * That exception is the whole reason this is a function and not a one-liner:
 * a message being republished — a DLQ replay, most of all — already carries
 * the trace context of its original publication, which is where the
 * correlation is worth the most. Overwriting it with the context of the
 * republishing request would destroy exactly what someone debugging a dead
 * letter is looking for. Such a publish gets a {@link linkToCarriedContext}
 * link instead of a new injection.
 *
 * The carrier must be a copy the caller owns: injecting into an object the
 * application handed us would leak a stale `traceparent` into the next publish
 * that reuses it.
 */
export function injectTraceContext(carrier: Record<string, unknown>): void {
  if (carrier[TRACEPARENT] !== undefined) return;
  propagation.inject(context.active(), carrier);
}

/** Does this carrier already hold a trace context someone else put there? */
export function hasCarriedContext(carrier: Record<string, unknown> | undefined): boolean {
  return carrier?.[TRACEPARENT] !== undefined;
}

/**
 * The context carried by an incoming (or replayed) message, extracted from its
 * `application_properties`. Returns `undefined` when the message carries none,
 * or when no propagator is registered — in which case a consumer span becomes
 * a root, and the application's sampler decides whether this service is an
 * entry point for traces.
 */
export function carriedContext(carrier: Record<string, unknown> | undefined): Context | undefined {
  if (!carrier) return undefined;
  const ctx = propagation.extract(ROOT_CONTEXT, carrier);
  const spanContext = trace.getSpanContext(ctx);
  if (!spanContext || !spanContext.traceId) return undefined;
  return ctx;
}

/** A span link to the context a message carries, for a republish or a reply. */
export function linkToCarriedContext(carrier: Record<string, unknown> | undefined): Link | undefined {
  const ctx = carriedContext(carrier);
  if (!ctx) return undefined;
  const spanContext = trace.getSpanContext(ctx);
  return spanContext ? { context: spanContext } : undefined;
}

/**
 * Mark a span as failed and end it. `errorType` is the low-cardinality
 * `error.type` the conventions ask for — here the AMQP outcome
 * (`released`, `rejected`, `unsent`, `timeout`, …) or the error's class name.
 */
export function failSpan(span: Span, errorType: string, err?: unknown): void {
  span.setAttribute(ATTR_ERROR_TYPE, errorType);
  span.setStatus({ code: SpanStatusCode.ERROR, message: describeForSpan(err) });
  if (err instanceof Error) span.recordException(err);
  span.end();
}

/** `error.type` for an arbitrary thrown value: its class name, or the value. */
export function errorTypeOf(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  return typeof err === 'string' ? err : typeof err;
}

function describeForSpan(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : undefined;
}

/** Run `fn` with `span` active, so nested publishes become its children. */
export function withSpan<T>(span: Span, parent: Context | undefined, fn: () => T): T {
  return context.with(trace.setSpan(parent ?? context.active(), span), fn);
}

/** Bind `fn` to `span`'s context — for callbacks that fire on a later tick
 *  (an rxjs subscription, an rhea event) where the ambient context is lost. */
export function bindToSpan<T extends (...args: never[]) => unknown>(
  span: Span,
  parent: Context | undefined,
  fn: T,
): T {
  return context.bind(trace.setSpan(parent ?? context.active(), span), fn);
}

export { SpanKind };
