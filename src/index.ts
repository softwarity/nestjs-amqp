export { AmqpModule } from './amqp.module';
export {
  type AmqpModuleOptions,
  type AmqpModuleAsyncOptions,
  type AmqpOptionsFactory,
  type ResolvedAmqpModuleOptions,
  AMQP_MODULE_OPTIONS,
} from './amqp.options';

export { AmqpClient } from './amqp.client';
export { Subscribe, SubscribeTopic, AMQP_SUBSCRIBE_METADATA } from './subscribe.decorator';
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
  EmitOptions,
  SendOptions,
  SubscribeMetadata,
  SubscribeOptions,
  SubscribeTopicOptions,
} from './amqp.types';
export type { DlqSession, HeldMessage, XDeath } from './dlq-browser.types';
