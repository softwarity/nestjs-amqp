import { DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AmqpConsumerExplorer } from './amqp.consumer-explorer';
import { AmqpDestinations } from './amqp.destinations';
import {
  AMQP_MODULE_OPTIONS,
  type AmqpModuleAsyncOptions,
  type AmqpOptionsFactory,
  type BrokerOptions,
  resolveAmqpOptions,
  type ResolvedAmqpModuleOptions,
} from './amqp.options';
import { BrokerRegistry } from './broker-registry';
import { DlqBrowserService } from './dlq-browser.service';

/**
 * Root module for the `@softwarity/nestjs-amqp` library.
 *
 * Use `AmqpModule.forRoot(options)` for static config, or
 * `AmqpModule.forRootAsync(...)` to pull options from `ConfigService` or any
 * async source. The module is `@Global` — any other module's providers can
 * use the `@AmqpQueue` / `@AmqpTopic` / `@Consume` / `@Subscribe`
 * decorators and inject {@link AmqpDestinations} without re-importing.
 *
 * The module supports one or several brokers. Pass a single
 * {@link BrokerOptions} (the 90% case) or an array of them. With a single
 * broker, the `brokerName` argument on decorators and locator methods is
 * optional.
 *
 * `DlqBrowserService` is always provided; import the optional
 * `DlqAdminModule` separately if you also want the HTTP browser API.
 */
@Global()
@Module({})
export class AmqpModule {
  static forRoot(options: BrokerOptions | BrokerOptions[]): DynamicModule {
    const resolved = resolveAmqpOptions(options);
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
    providers: [...providers, BrokerRegistry, AmqpConsumerExplorer, AmqpDestinations, DlqBrowserService],
    exports: [AMQP_MODULE_OPTIONS, BrokerRegistry, AmqpDestinations, DlqBrowserService],
  };
}

function createAsyncOptionsProvider(asyncOptions: AmqpModuleAsyncOptions): Provider {
  if (asyncOptions.useFactory) {
    return {
      provide: AMQP_MODULE_OPTIONS,
      useFactory: async (...args: unknown[]): Promise<ResolvedAmqpModuleOptions> => {
        const opts = await asyncOptions.useFactory!(...args);
        return resolveAmqpOptions(opts);
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
      return resolveAmqpOptions(opts);
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
