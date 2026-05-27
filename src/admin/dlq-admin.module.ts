import { Module } from '@nestjs/common';
import { DlqAdminController } from './dlq-admin.controller';

/**
 * Optional admin module exposing HTTP endpoints to browse / replay / drop
 * dead-lettered messages. Import this in your application module only if you
 * want the HTTP API; the underlying `DlqBrowserService` is always available
 * from `AmqpModule` for programmatic use.
 *
 * The controller is intentionally un-guarded — wrap it with your own auth
 * (global guards, controller-level Guards via mixins, or by re-declaring the
 * routes in a subclass with your decorators).
 *
 * ```ts
 * @Module({
 *   imports: [
 *     AmqpModule.forRoot({ appName: 'my-svc', url: 'amqp://...' }),
 *     DlqAdminModule,
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({
  controllers: [DlqAdminController],
})
export class DlqAdminModule {}
