// Minimal ambient declarations for the parts of `rhea` we use.
// `@types/rhea` does not exist on DefinitelyTyped; rhea-promise has its own
// typings but is a Promise wrapper (incompatible with our RxJS-only rule).
// This file covers strictly what `AmqpClient`, `AmqpPublisher` and
// `AmqpConsumerExplorer` call. Anything else stays untyped.

declare module 'rhea' {
  export interface ConnectionOptions {
    host?: string;
    port?: number;
    transport?: 'tcp' | 'tls' | 'ssl';
    username?: string;
    password?: string;
    container_id?: string;
    idle_time_out?: number;
    reconnect?: boolean;
    reconnect_limit?: number; // -1 = infinite
    initial_reconnect_delay?: number;
    max_reconnect_delay?: number;
  }

  export interface Source {
    address?: string;
    dynamic?: boolean;
    durable?: 0 | 1 | 2;
    expiry_policy?: 'link-detach' | 'session-end' | 'connection-close' | 'never';
    /** AMQP 1.0 source filter set — broker-specific descriptors keyed by
     *  symbol. We use it for `rabbitmq:stream-offset-spec` to position the
     *  consumer on a stream queue. */
    filter?: Record<string, unknown>;
  }

  export interface Target {
    address?: string;
    dynamic?: boolean;
    durable?: 0 | 1 | 2;
  }

  export interface ReceiverOptions {
    source?: Source | string;
    target?: Target | string;
    autoaccept?: boolean;
    credit_window?: number;
    name?: string;
  }

  export interface SenderOptions {
    source?: Source | string;
    target?: Target | string;
    autosettle?: boolean;
    name?: string;
  }

  export interface MessageProperties {
    message_id?: string | number;
    user_id?: string;
    to?: string;
    subject?: string;
    reply_to?: string;
    correlation_id?: string | number;
    content_type?: string;
    content_encoding?: string;
    absolute_expiry_time?: number;
    creation_time?: number;
    group_id?: string;
    group_sequence?: number;
    reply_to_group_id?: string;
  }

  export interface MessageHeader {
    durable?: boolean;
    priority?: number;
    ttl?: number;
    first_acquirer?: boolean;
    delivery_count?: number;
  }

  export interface Message {
    body?: unknown;
    properties?: MessageProperties;
    header?: MessageHeader;
    application_properties?: Record<string, unknown>;
    message_annotations?: Record<string, unknown>;
    delivery_annotations?: Record<string, unknown>;
    durable?: boolean;
    priority?: number;
    ttl?: number;
  }

  export interface DeliveryRejectError {
    condition: string;
    description?: string;
  }

  export interface DeliveryModifiedOptions {
    delivery_failed?: boolean;
    undeliverable_here?: boolean;
    message_annotations?: Record<string, unknown>;
  }

  export interface Delivery {
    accept(): void;
    release(opts?: { delivery_failed?: boolean }): void;
    reject(error: DeliveryRejectError): void;
    modified(opts: DeliveryModifiedOptions): void;
    readonly remote_state?: unknown;
    readonly settled?: boolean;
  }

  export interface EventContext {
    message?: Message;
    delivery?: Delivery;
    receiver?: Receiver;
    sender?: Sender;
    connection?: Connection;
    container?: Container;
  }

  export interface EventEmitter {
    on(event: string, handler: (context: EventContext) => void): void;
    once(event: string, handler: (context: EventContext) => void): void;
    removeListener(event: string, handler: (context: EventContext) => void): void;
    removeAllListeners(event?: string): void;
  }

  export interface Receiver extends EventEmitter {
    source: { address?: string; dynamic?: boolean };
    target: { address?: string };
    add_credit(n: number): void;
    set_credit_window(n: number): void;
    close(error?: DeliveryRejectError): void;
    detach(error?: DeliveryRejectError): void;
    is_open(): boolean;
    is_closed(): boolean;
  }

  export interface Sender extends EventEmitter {
    source: { address?: string };
    target: { address?: string };
    send(message: Message): Delivery;
    sendable(): boolean;
    has_credit(): boolean;
    close(error?: DeliveryRejectError): void;
    detach(error?: DeliveryRejectError): void;
    is_open(): boolean;
    is_closed(): boolean;
  }

  export interface Connection extends EventEmitter {
    open_receiver(options?: ReceiverOptions | string): Receiver;
    open_sender(options?: SenderOptions | string): Sender;
    close(): void;
    is_open(): boolean;
    is_closed(): boolean;
  }

  export interface Container extends EventEmitter {
    connect(options: ConnectionOptions): Connection;
    id: string;
  }

  interface RheaContainer extends Container {
    create_container(options?: { id?: string }): Container;
  }
  const rhea: RheaContainer;
  export = rhea;
}
