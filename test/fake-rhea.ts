import type { Delivery, EventContext, Message } from 'rhea';

/**
 * Hand-driven stand-ins for the slice of rhea this library touches: credit,
 * delivery outcomes, link and connection events. Shared by the specs that need
 * to make a broker behave a certain way — delivery verdicts, telemetry — rather
 * than each of them growing its own copy.
 *
 * Not named `*.spec.ts` on purpose: jest collects specs, not helpers.
 */

export type Handler = (ctx: EventContext) => void;

export class FakeEmitter {
  private readonly handlers = new Map<string, { fn: Handler; original: Handler }[]>();

  on(event: string, fn: Handler): void {
    this.entries(event).push({ fn, original: fn });
  }

  once(event: string, fn: Handler): void {
    const wrapper: Handler = (ctx) => {
      this.removeListener(event, fn);
      fn(ctx);
    };
    this.entries(event).push({ fn: wrapper, original: fn });
  }

  removeListener(event: string, fn: Handler): void {
    const list = this.entries(event);
    const idx = list.findIndex((e) => e.original === fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  removeAllListeners(event?: string): void {
    if (event) this.handlers.delete(event);
    else this.handlers.clear();
  }

  /** Number of listeners currently attached — used to assert teardown. */
  listenerCount(event: string): number {
    return this.entries(event).length;
  }

  /** Deliver an event to the listeners registered at this instant. */
  fire(event: string, ctx: EventContext = {}): void {
    for (const entry of [...this.entries(event)]) entry.fn(ctx);
  }

  private entries(event: string): { fn: Handler; original: Handler }[] {
    let list = this.handlers.get(event);
    if (!list) {
      list = [];
      this.handlers.set(event, list);
    }
    return list;
  }
}

export class FakeSender extends FakeEmitter {
  readonly sent: Message[] = [];
  credit = true;
  opened = true;
  private nextId = 0;

  send(message: Message): Delivery {
    this.sent.push(message);
    return { id: this.nextId++ } as Delivery;
  }

  sendable(): boolean {
    return this.credit;
  }

  has_credit(): boolean {
    return this.credit;
  }

  close(): void {
    this.opened = false;
  }

  detach(): void {
    this.opened = false;
  }

  is_open(): boolean {
    return this.opened;
  }

  is_closed(): boolean {
    return !this.opened;
  }

  /** Deliver a disposition for the delivery at index `deliveryId`. */
  outcome(event: 'accepted' | 'released' | 'rejected' | 'modified', deliveryId = 0, error?: unknown): void {
    this.fire(event, { delivery: { id: deliveryId, remote_state: { error } } as unknown as Delivery });
  }
}

export class FakeReceiver extends FakeEmitter {
  opened = true;
  readonly credits: number[] = [];

  constructor(readonly address: string) {
    super();
  }

  add_credit(n: number): void {
    this.credits.push(n);
  }

  set_credit_window(): void {}

  close(): void {
    this.opened = false;
  }

  detach(): void {
    this.opened = false;
  }

  is_open(): boolean {
    return this.opened;
  }

  is_closed(): boolean {
    return !this.opened;
  }
}

export class FakeConnection extends FakeEmitter {
  readonly senders = new Map<string, FakeSender>();
  /** Every receiver ever attached, in order — a leak shows up as growth here. */
  readonly receivers: FakeReceiver[] = [];
  /** How many times a sender link was actually attached (each one costs the
   *  broker a session, which is what the channel-exhaustion bug was about). */
  openedSenders = 0;
  opened = true;

  open_sender(options: { target?: { address?: string } } | string): FakeSender {
    const address = typeof options === 'string' ? options : (options.target?.address ?? '');
    const existing = this.senders.get(address);
    if (existing?.is_open()) return existing;
    const sender = new FakeSender();
    this.senders.set(address, sender);
    this.openedSenders += 1;
    return sender;
  }

  open_receiver(options: { source?: { address?: string } | string } | string): FakeReceiver {
    const source = typeof options === 'string' ? options : options.source;
    const address = typeof source === 'string' ? source : (source?.address ?? '');
    const receiver = new FakeReceiver(address);
    this.receivers.push(receiver);
    return receiver;
  }

  close(): void {
    this.opened = false;
  }

  is_open(): boolean {
    return this.opened;
  }

  is_closed(): boolean {
    return !this.opened;
  }
}
