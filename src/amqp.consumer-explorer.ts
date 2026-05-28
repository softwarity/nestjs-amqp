import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { isObservable, Subscription } from 'rxjs';
import type { Delivery } from 'rhea';
import { AMQP_PARAMS_METADATA, type AmqpContext, type AmqpSettler } from './amqp.param-decorators';
import type { AmqpParamMeta, ConsumerMetadata, IncomingMessage, RetryPolicy } from './amqp.types';
import type { BrokerConnection } from './broker-connection';
import { BrokerRegistry } from './broker-registry';
import { AMQP_CONSUMER_METADATA } from './consumers.decorator';

/**
 * Walks every provider at module-init time, finds methods carrying
 * `AMQP_CONSUMER_METADATA`, resolves the target broker via the
 * {@link BrokerRegistry}, validates each method's parameters are fully
 * annotated with `@Amqp*()` decorators (throws at boot otherwise), opens a
 * receiver per handler, dispatches each incoming message and applies the
 * `maxDelivery` / `dlq` policy on error. Reply routing
 * (`msg.reply_to` → `broker.publish`) happens here too — there's no separate
 * "replier" service.
 *
 * In 0.2.x only `retryPolicy: 'immediate'` is functional. Other policies
 * are accepted by the type system and validated for shape, but the runtime
 * silently treats them as `'immediate'` with a one-line boot warning.
 * Wired in a later release.
 */
@Injectable()
export class AmqpConsumerExplorer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AmqpConsumerExplorer.name);

  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly registry: BrokerRegistry,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    // Per-broker collection of (kind, address, target) tuples so we can log
    // a clean topology summary at boot — one line per broker, listing every
    // destination it consumes from with its decorator flavour.
    const perBroker = new Map<string, string[]>();
    for (const name of this.registry.names()) perBroker.set(name, []);

    const providers = this.discovery.getProviders();
    providers.forEach((wrapper) => {
      const instance = wrapper.instance as object | undefined;
      if (!instance || typeof instance !== 'object') return;
      const prototype = Object.getPrototypeOf(instance) as object | null;
      if (!prototype) return;
      const methodNames = this.scanner.getAllMethodNames(prototype);
      methodNames.forEach((name) => {
        const meta = Reflect.getMetadata(AMQP_CONSUMER_METADATA, prototype, name) as ConsumerMetadata | undefined;
        if (meta) {
          const broker = this.resolveBroker(meta, instance, name);
          this.wire(broker, instance, prototype, name, meta);
          perBroker
            .get(broker.options.name)
            ?.push(`@${decoratorName(meta)} ${meta.address} -> ${describeHandler(instance, name)}`);
        }
      });
    });

    for (const [brokerName, entries] of perBroker) {
      if (entries.length === 0) {
        this.logger.log(`broker '${brokerName}': no consumers`);
        continue;
      }
      this.logger.log(`broker '${brokerName}': ${entries.length} consumer(s)`);
      for (const entry of entries) this.logger.log(`  - ${entry}`);
    }
  }

  private resolveBroker(meta: ConsumerMetadata, instance: object, methodName: string): BrokerConnection {
    try {
      return this.registry.resolveConnection(meta.brokerName);
    } catch (err) {
      const where = `${describeHandler(instance, methodName)} (@${decoratorName(meta)} '${meta.address}')`;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot wire ${where}: ${reason}`);
    }
  }

  private wire(
    broker: BrokerConnection,
    instance: object,
    prototype: object,
    methodName: string,
    meta: ConsumerMetadata,
  ): void {
    const ctor = (instance as { constructor: { name: string } }).constructor.name;
    const method = (instance as Record<string, unknown>)[methodName] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof method !== 'function') {
      throw new Error(`@${decoratorName(meta)} handler ${ctor}.${methodName} is not a callable method`);
    }
    if (meta.options.dlq && !broker.options.defaultDlqAddress) {
      this.logger.warn(
        `@${decoratorName(meta)} '${meta.address}' on broker '${broker.options.name}' has dlq:true but the broker has no defaultDlqAddress configured. ` +
          `The lib will still delivery.reject() on terminal failure — make sure the queue's DLX is set up broker-side or the message will be dropped.`,
      );
    }
    if (meta.options.retryPolicy !== 'immediate') {
      this.logger.warn(
        `@${decoratorName(meta)} '${meta.address}' on broker '${broker.options.name}' declares retryPolicy=${describeRetryPolicy(meta.options.retryPolicy)} ` +
          `but only 'immediate' is implemented in 0.2.x — falling back to immediate. Client-side scheduled republish is planned for 0.3.x.`,
      );
    }
    const params = this.readAndValidateParams(meta, prototype, methodName, ctor, method.length);
    this.logger.debug(
      `@${decoratorName(meta)} '${meta.address}' -> ${ctor}.${methodName} on broker '${broker.options.name}' ` +
        `(maxDelivery=${meta.options.maxDelivery}, retryPolicy=${describeRetryPolicy(meta.options.retryPolicy)}, dlq=${meta.options.dlq})`,
    );
    const sub = broker
      .messages$(meta.address, { creditWindow: meta.options.maxWindow, streamOffset: meta.options.streamOffset })
      .subscribe({
        next: (incoming) => this.dispatch(broker, instance, method, params, meta, incoming),
        error: (err) => this.logger.error(`messages$ '${meta.address}' errored: ${describe(err)}`),
      });
    this.subscriptions.push(sub);
  }

  /**
   * Read the per-parameter `@Amqp*()` metadata, applying the implicit-body
   * convention: exactly **one** un-annotated parameter is allowed and is
   * bound to the decoded message body (the dominant case). The rule fails
   * fast at boot — never silently at runtime:
   *
   *   - 0 un-annotated → all explicit, pass through.
   *   - 1 un-annotated → synthesise `{ kind: 'BODY' }` for that slot,
   *     **unless** an explicit `@AmqpBody()` already exists elsewhere on
   *     the method (mixing styles is confusing — refuse and ask the
   *     developer to pick one).
   *   - 2+ un-annotated → ambiguous (which one is the body?), throw.
   */
  private readAndValidateParams(
    meta: ConsumerMetadata,
    prototype: object,
    methodName: string,
    ctor: string,
    arity: number,
  ): AmqpParamMeta[] {
    const params = (Reflect.getMetadata(AMQP_PARAMS_METADATA, prototype, methodName) ?? []) as AmqpParamMeta[];
    const unannotated: number[] = [];
    for (let i = 0; i < arity; i++) {
      if (!params[i]) unannotated.push(i);
    }
    if (unannotated.length === 0) return params;
    const decoTag = `@${decoratorName(meta)}`;
    if (unannotated.length > 1) {
      throw new Error(
        `${decoTag} handler ${ctor}.${methodName} has ${unannotated.length} un-annotated parameters ` +
          `(indices ${unannotated.join(', ')}). At most one is allowed - it is bound as @AmqpBody(). ` +
          `Annotate the others with @AmqpContext() / @AmqpSettler() / @AmqpDeliveryCount() / @AmqpProperties() / etc.`,
      );
    }
    if (params.some((p) => p?.kind === 'BODY')) {
      throw new Error(
        `${decoTag} handler ${ctor}.${methodName} mixes an explicit @AmqpBody() with an un-annotated ` +
          `parameter at index ${unannotated[0]}. Pick one style: either annotate every parameter, or omit ` +
          `@AmqpBody() and let the single un-annotated parameter receive the body.`,
      );
    }
    // Clone the sparse array - we don't want to mutate the cached reflect
    // metadata, only the local view used to bind this handler's arguments.
    const result = [...params];
    result[unannotated[0]!] = { kind: 'BODY' };
    return result;
  }

  private dispatch(
    broker: BrokerConnection,
    instance: object,
    method: (...args: unknown[]) => unknown,
    params: AmqpParamMeta[],
    meta: ConsumerMetadata,
    incoming: IncomingMessage,
  ): void {
    const ctx = buildContext(meta.address, incoming, broker);
    const args = params.map((p) => resolveArg(p, incoming, ctx, broker));

    let result: unknown;
    try {
      result = method.apply(instance, args);
    } catch (err) {
      this.logger.warn(`handler '${meta.address}' threw: ${describe(err)}`);
      if (!ctx.settled) applyErrorPolicy(meta.options, ctx.deliveryCount, incoming.delivery, err);
      return;
    }

    if (isObservable(result)) {
      result.subscribe({
        next: (value: unknown) => this.replyIfRequested(broker, incoming, value),
        complete: () => {
          if (!ctx.settled) incoming.delivery.accept();
        },
        error: (err: unknown) => {
          this.logger.warn(`handler '${meta.address}' Observable errored: ${describe(err)}`);
          if (!ctx.settled) applyErrorPolicy(meta.options, ctx.deliveryCount, incoming.delivery, err);
        },
      });
      return;
    }
    if (result !== undefined) this.replyIfRequested(broker, incoming, result);
    if (!ctx.settled) incoming.delivery.accept();
  }

  private replyIfRequested(broker: BrokerConnection, incoming: IncomingMessage, value: unknown): void {
    const replyTo = incoming.message.properties?.reply_to;
    if (!replyTo) return;
    broker.publish(replyTo, {
      body: broker.encodeBody(value),
      properties: { correlation_id: incoming.message.properties?.correlation_id },
    });
  }

  onModuleDestroy(): void {
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.subscriptions.length = 0;
  }
}

function resolveArg(
  meta: AmqpParamMeta,
  incoming: IncomingMessage,
  ctx: AmqpContext,
  broker: BrokerConnection,
): unknown {
  switch (meta.kind) {
    case 'BODY':
      return broker.decodeBody(incoming.message.body);
    case 'ADDRESS':
      return ctx.address;
    case 'DELIVERY_COUNT':
      return ctx.deliveryCount;
    case 'HEADER':
      return incoming.message.header ?? {};
    case 'PROPERTIES':
      return ctx.properties;
    case 'PROPERTY':
      return meta.key === undefined ? undefined : ctx.properties[meta.key as keyof typeof ctx.properties];
    case 'APP_PROPERTIES':
      return ctx.applicationProperties;
    case 'APP_PROPERTY':
      return meta.key === undefined ? undefined : ctx.applicationProperties[meta.key];
    case 'SETTLER':
      return makeSettler(ctx);
    case 'CONTEXT':
      return ctx;
  }
}

function makeSettler(ctx: AmqpContext): AmqpSettler {
  return {
    accept: () => ctx.accept(),
    release: () => ctx.release(),
    reject: (error) => ctx.reject(error),
  };
}

function buildContext(address: string, incoming: IncomingMessage, _broker: BrokerConnection): AmqpContext {
  let settled = false;
  // AMQP `delivery_count` is the number of UNSUCCESSFUL prior deliveries (0
  // on first attempt). We expose a 1-based attempt number for ergonomics.
  const deliveryCount = (incoming.message.header?.delivery_count ?? 0) + 1;
  return {
    address,
    properties: incoming.message.properties ?? {},
    applicationProperties: incoming.message.application_properties ?? {},
    header: incoming.message.header ?? {},
    deliveryCount,
    get settled(): boolean {
      return settled;
    },
    accept(): void {
      settled = true;
      incoming.delivery.accept();
    },
    release(): void {
      settled = true;
      incoming.delivery.release();
    },
    reject(error): void {
      settled = true;
      incoming.delivery.reject(error ?? { condition: 'amqp:internal-error' });
    },
  };
}

/**
 * The automatic error policy. Compares the current 1-based `deliveryCount` to
 * `maxDelivery`:
 *   - more attempts allowed → `delivery.modified({delivery_failed: true})`,
 *     broker re-delivers with `delivery_count + 1`
 *   - last attempt → `dlq ? reject() : accept()`
 *
 * In 0.2.x retry timing is delegated entirely to the broker — `retryPolicy`
 * is read at boot for validation only. The runtime always behaves as
 * `'immediate'`. Client-side scheduled republish (fixed / exponential) will
 * be wired in 0.3.x.
 */
function applyErrorPolicy(
  opts: { maxDelivery: number; dlq: boolean; retryPolicy: RetryPolicy },
  deliveryCount: number,
  delivery: Delivery,
  err: unknown,
): void {
  if (deliveryCount >= opts.maxDelivery) {
    if (opts.dlq) {
      delivery.reject({ condition: 'amqp:internal-error', description: describe(err) });
    } else {
      delivery.accept();
    }
    return;
  }
  delivery.modified({ delivery_failed: true, undeliverable_here: false });
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const e = err as { description?: string; condition?: string };
    return e.description ?? e.condition ?? JSON.stringify(err);
  }
  return String(err);
}

function describeHandler(instance: object, methodName: string): string {
  const ctor = (instance as { constructor: { name: string } }).constructor.name;
  return `${ctor}.${methodName}`;
}

function decoratorName(meta: ConsumerMetadata): 'Consume' | 'Subscribe' {
  return meta.kind === 'consume' ? 'Consume' : 'Subscribe';
}

function describeRetryPolicy(policy: RetryPolicy): string {
  if (policy === 'immediate') return 'immediate';
  if (policy.kind === 'fixed') return `fixed(${policy.delayMs}ms)`;
  return `exponential(initial=${policy.initialMs}ms, x${policy.multiplier}, max=${policy.maxMs}ms)`;
}
