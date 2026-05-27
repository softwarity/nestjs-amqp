import { DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AmqpClient } from './amqp.client';
import { AmqpConsumerExplorer } from './amqp.consumer-explorer';
import {
  AMQP_MODULE_OPTIONS,
  type AmqpModuleAsyncOptions,
  type AmqpModuleOptions,
  type AmqpOptionsFactory,
  resolveAmqpOptions,
  type ResolvedAmqpModuleOptions,
} from './amqp.options';
import { AmqpPublisher } from './amqp.publisher';
import { setActiveBodyCodec } from './body-codec';
import { DlqBrowserService } from './dlq-browser.service';

/**
 * Root module for the `@softwarity/nestjs-amqp` library.
 *
 * Use `AmqpModule.forRoot(options)` for static config, or
 * `AmqpModule.forRootAsync(...)` to pull options from `ConfigService` or any
 * async source. The module is `@Global` — any other module's providers can
 * use the `@AmqpQueue` / `@AmqpTopic` / `@Subscribe` decorators without
 * re-importing.
 *
 * `DlqBrowserService` is always provided; import the optional
 * `DlqAdminModule` separately if you also want the HTTP browser API.
 */
@Global()
@Module({})
export class AmqpModule {
  static forRoot(options: AmqpModuleOptions = {}): DynamicModule {
    const resolved = resolveAmqpOptions(options);
    setActiveBodyCodec(resolved.bodyCodec);
    const optionsProvider: Provider = {
      provide: AMQP_MODULE_OPTIONS,
      useValue: resolved,
    };
    return buildModule([optionsProvider]);
  }

  static forRootAsync(asyncOptions: AmqpModuleAsyncOptions): DynamicModule {
    const optionsProvider = createAsyncOptionsProvider(asyncOptions);
    const extraProviders = createAsyncFactoryProviders(asyncOptions);
    return buildModule([optionsProvider, ...extraProviders], asyncOptions.imports ?? []);
  }
}

function buildModule(providers: Provider[], imports: NonNullable<DynamicModule['imports']> = []): DynamicModule {
  return {
    module: AmqpModule,
    imports: [DiscoveryModule, ...imports],
    providers: [...providers, AmqpClient, AmqpPublisher, AmqpConsumerExplorer, DlqBrowserService],
    exports: [AMQP_MODULE_OPTIONS, AmqpClient, DlqBrowserService],
  };
}

function createAsyncOptionsProvider(asyncOptions: AmqpModuleAsyncOptions): Provider {
  if (asyncOptions.useFactory) {
    return {
      provide: AMQP_MODULE_OPTIONS,
      useFactory: async (...args: unknown[]): Promise<ResolvedAmqpModuleOptions> => {
        const opts = await asyncOptions.useFactory!(...args);
        const resolved = resolveAmqpOptions(opts);
        setActiveBodyCodec(resolved.bodyCodec);
        return resolved;
      },
      inject: asyncOptions.inject ?? [],
    };
  }
  const factoryToken = asyncOptions.useClass ?? asyncOptions.useExisting;
  if (!factoryToken) {
    throw new Error('AmqpModule.forRootAsync requires one of: useFactory, useClass, useExisting');
  }
  return {
    provide: AMQP_MODULE_OPTIONS,
    useFactory: async (factory: AmqpOptionsFactory): Promise<ResolvedAmqpModuleOptions> => {
      const opts = await factory.createAmqpOptions();
      const resolved = resolveAmqpOptions(opts);
      setActiveBodyCodec(resolved.bodyCodec);
      return resolved;
    },
    inject: [factoryToken],
  };
}

function createAsyncFactoryProviders(asyncOptions: AmqpModuleAsyncOptions): Provider[] {
  if (asyncOptions.useClass) {
    return [{ provide: asyncOptions.useClass, useClass: asyncOptions.useClass }];
  }
  return [];
}
