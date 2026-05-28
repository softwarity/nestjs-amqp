export { AmqpModule } from './amqp.module';
export {
  type AmqpModuleAsyncOptions,
  type AmqpOptionsFactory,
  type BrokerOptions,
  type ResolvedAmqpModuleOptions,
  type ResolvedBrokerOptions,
  AMQP_MODULE_OPTIONS,
} from './amqp.options';

// Multi-broker primitives. `BrokerRegistry` is exposed so advanced users can
// reach a specific broker imperatively (e.g. dual-write across brokers);
// `BrokerConnection` and `BrokerPublisher` are exported as TYPES only — they
// are constructed by the registry, not by user code.
export { BrokerRegistry } from './broker-registry';
export { type BrokerConnection, type BrokerBrand } from './broker-connection';
export { type BrokerPublisher } from './broker-publisher';

export { AmqpDestinations } from './amqp.destinations';

export { Consume, Subscribe, AMQP_CONSUMER_METADATA } from './consumers.decorator';
export { AmqpQueue, AmqpTopic } from './amqp.queue';

export {
  AmqpBody,
  AmqpAddress,
  AmqpDeliveryCount,
  AmqpHeader,
  AmqpProperties,
  AmqpProperty,
  AmqpAppProperties,
  AmqpAppProperty,
  AmqpSettler,
  AmqpContext,
  AMQP_PARAMS_METADATA,
} from './amqp.param-decorators';

export { AmqpError, AmqpConnectionError, AmqpHandlerError, AmqpTimeoutError } from './amqp.errors';

export { type AmqpBodyCodec, JsonBodyCodec, defaultBodyCodec } from './body-codec';

// DLQ browser — service for programmatic use, types for typed integrations.
// The optional HTTP module is exported separately as `DlqAdminModule` so
// callers opt-in.
export { DlqBrowserService } from './dlq-browser.service';
export { DlqAdminModule } from './admin/dlq-admin.module';
export { DlqAdminController } from './admin/dlq-admin.controller';
export {
  OpenSessionRequestDto,
  type DlqSessionResponseDto,
  type HeldMessageDto,
  type XDeathDto,
  toSessionDto,
} from './admin/dlq.dto';

export type {
  AmqpParamKind,
  AmqpParamMeta,
  ConsumeOptions,
  ConsumerMetadata,
  EmitOptions,
  ResolvedConsumerOptions,
  RetryPolicy,
  SendOptions,
  SubscribeOptions,
} from './amqp.types';
export type { DlqSession, HeldMessage, XDeath } from './dlq-browser.types';
