import { resolveAmqpOptions } from '../src/amqp.options';

describe('resolveAmqpOptions', () => {
  it('applies all defaults when called with no input', () => {
    const r = resolveAmqpOptions({});
    expect(r.enabled).toBe(true);
    expect(r.url).toBe('amqp://localhost:5672');
    expect(r.reconnectLimit).toBe(-1);
    expect(r.initialReconnectDelayMs).toBe(100);
    expect(r.maxReconnectDelayMs).toBe(30000);
    expect(r.idleTimeoutMs).toBe(60000);
    expect(r.defaultSendTimeoutMs).toBe(30000);
    expect(r.autoPrefixQueues).toBe(true);
    expect(r.replyStreamAddress).toBeUndefined();
    expect(r.defaultDlqAddress).toBeUndefined();
  });

  it('derives replyStreamAddress and defaultDlqAddress from appName', () => {
    const r = resolveAmqpOptions({ appName: 'my-svc' });
    expect(r.replyStreamAddress).toBe('my-svc.replies');
    expect(r.defaultDlqAddress).toBe('my-svc.dlq');
  });

  it('keeps explicit overrides over the appName-derived defaults', () => {
    const r = resolveAmqpOptions({
      appName: 'my-svc',
      replyStreamAddress: 'shared.replies',
      defaultDlqAddress: 'shared.dlq',
    });
    expect(r.replyStreamAddress).toBe('shared.replies');
    expect(r.defaultDlqAddress).toBe('shared.dlq');
  });

  it('preserves enabled=false', () => {
    expect(resolveAmqpOptions({ enabled: false }).enabled).toBe(false);
  });
});
