import type { Message } from 'rhea';
import { AMQP_PROPERTIES_KEYS, normalizeIncoming, toRheaOutgoing } from '../src/rhea-adapter';

// These tests would have caught the regression that broke every `send()`
// round-trip on real brokers: rhea decodes the AMQP 1.0 `properties`
// composite section into TOP-LEVEL message fields, not into a nested
// `properties` object. Any code path that reads `message.properties.X`
// from an incoming message silently sees `undefined`, and any send that
// stuffs reply_to / correlation_id under a nested `properties` ships an
// empty AMQP properties section. We normalise both sides here.

describe('normalizeIncoming', () => {
  it('reconstructs `properties` from the top-level fields rhea posts', () => {
    const rheaShape = {
      body: 'hello',
      reply_to: '/queues/replies',
      correlation_id: 'corr-1',
      message_id: 'msg-1',
      subject: 'demo',
    } as unknown as Message;
    const normalised = normalizeIncoming(rheaShape);
    expect(normalised.properties).toEqual({
      reply_to: '/queues/replies',
      correlation_id: 'corr-1',
      message_id: 'msg-1',
      subject: 'demo',
    });
  });

  it('omits fields that are undefined or null', () => {
    const rheaShape = { body: 'hi', reply_to: undefined, correlation_id: null } as unknown as Message;
    const normalised = normalizeIncoming(rheaShape);
    expect(normalised.properties).toEqual({});
  });

  it('preserves the original top-level fields (we do not mutate rhea output)', () => {
    const rheaShape = { body: 'hi', reply_to: '/queues/r', correlation_id: 'c' } as unknown as Message;
    const normalised = normalizeIncoming(rheaShape) as Message & Record<string, unknown>;
    expect(normalised.reply_to).toBe('/queues/r');
    expect(normalised.correlation_id).toBe('c');
  });

  it('passes through application_properties and message_annotations unchanged', () => {
    const rheaShape = {
      body: 'hi',
      reply_to: '/queues/r',
      application_properties: { tenant: 'acme', trace: 't-1' },
      message_annotations: { 'x-stream-offset': 42 },
    } as unknown as Message;
    const normalised = normalizeIncoming(rheaShape);
    expect(normalised.application_properties).toEqual({ tenant: 'acme', trace: 't-1' });
    expect(normalised.message_annotations).toEqual({ 'x-stream-offset': 42 });
  });

  it('produces an empty properties object when no standard fields are present', () => {
    const rheaShape = { body: 'hi' } as unknown as Message;
    expect(normalizeIncoming(rheaShape).properties).toEqual({});
  });
});

describe('toRheaOutgoing', () => {
  it('flattens nested properties to the top level (what rhea reads)', () => {
    const outgoing = {
      body: 'hello',
      properties: { reply_to: '/queues/r', correlation_id: 'corr-1', message_id: 'm-1' },
    } as Message;
    const flattened = toRheaOutgoing(outgoing) as Message & Record<string, unknown>;
    expect(flattened.reply_to).toBe('/queues/r');
    expect(flattened.correlation_id).toBe('corr-1');
    expect(flattened.message_id).toBe('m-1');
    expect((flattened as { properties?: unknown }).properties).toBeUndefined();
  });

  it('is a no-op when properties is missing', () => {
    const outgoing = { body: 'hi' } as Message;
    expect(toRheaOutgoing(outgoing)).toEqual({ body: 'hi' });
  });

  it('lets properties override conflicting top-level fields (properties wins)', () => {
    const outgoing = {
      body: 'hi',
      reply_to: '/queues/old',
      properties: { reply_to: '/queues/new' },
    } as unknown as Message;
    const flattened = toRheaOutgoing(outgoing) as Message & Record<string, unknown>;
    expect(flattened.reply_to).toBe('/queues/new');
  });

  it('preserves application_properties and other non-properties sections', () => {
    const outgoing = {
      body: 'hi',
      properties: { correlation_id: 'c' },
      application_properties: { tenant: 'acme' },
    } as Message;
    const flattened = toRheaOutgoing(outgoing) as Message & Record<string, unknown>;
    expect(flattened.application_properties).toEqual({ tenant: 'acme' });
    expect(flattened.correlation_id).toBe('c');
  });
});

describe('AMQP_PROPERTIES_KEYS', () => {
  it('matches the AMQP 1.0 properties composite (in declaration order)', () => {
    // Sanity check — the keys list mirrors rhea's `define_composite_section`
    // for the `properties` section (lib/message.js). If rhea ever extends
    // the standard list, this test still passes but normalizeIncoming will
    // silently drop the new field — bump the list, add a case here.
    expect(AMQP_PROPERTIES_KEYS).toEqual([
      'message_id',
      'user_id',
      'to',
      'subject',
      'reply_to',
      'correlation_id',
      'content_type',
      'content_encoding',
      'absolute_expiry_time',
      'creation_time',
      'group_id',
      'group_sequence',
      'reply_to_group_id',
    ]);
  });
});

describe('round-trip: toRheaOutgoing → normalizeIncoming', () => {
  it('preserves the standard properties when crossing the rhea boundary', () => {
    // What `send()` does: a nested-shape message becomes the rhea flat-shape
    // on the wire, then comes back as flat-shape on the receiver side and
    // gets normalised back to nested. The round-trip should be identity for
    // the `properties` block.
    const original = {
      body: 'ping',
      properties: {
        reply_to: '/queues/replies',
        correlation_id: 'corr-1',
        message_id: 'msg-1',
        subject: 'demo',
      },
    } as Message;
    const onWire = toRheaOutgoing(original);
    const received = normalizeIncoming(onWire);
    expect(received.properties).toEqual(original.properties);
  });
});
