import type { DlqSession, HeldMessage, XDeath } from '../dlq-browser.types';

/** Body of `POST /admin/dlq/sessions`. Validation is left to the host app
 *  (class-validator is intentionally not a dependency of this library). */
export class OpenSessionRequestDto {
  /** DLQ address to browse (bare name; the configured prefix is added
   *  internally). */
  dlqAddress!: string;
  /** Max messages drained at a time. Default 20, hard max 200. */
  pageSize?: number;
}

export interface XDeathDto {
  queue: string;
  reason: string;
  count: number;
  exchange: string;
  'routing-keys': string[];
  'first-time'?: string;
  'last-time'?: string;
}

export interface HeldMessageDto {
  idx: number;
  body: unknown;
  properties: Record<string, unknown>;
  applicationProperties: Record<string, unknown>;
  xDeath: XDeathDto[];
}

export interface DlqSessionResponseDto {
  token: string;
  brokerName: string;
  dlqAddress: string;
  openedBy: string;
  openedAt: string;
  lastActivityAt: string;
  pageSize: number;
  pageIndex: number;
  messages: HeldMessageDto[];
}

/** Serialise an internal session (which holds rhea handles) into the public
 *  DTO shape — strips Delivery/Message, keeps decoded values. */
export function toSessionDto(session: DlqSession): DlqSessionResponseDto {
  const messages = [...session.messages.values()].sort((a, b) => a.idx - b.idx).map(toHeldMessageDto);
  return {
    token: session.token,
    brokerName: session.brokerName,
    dlqAddress: session.dlqAddress,
    openedBy: session.openedBy,
    openedAt: session.openedAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pageSize: session.pageSize,
    pageIndex: session.pageIndex,
    messages,
  };
}

function toHeldMessageDto(held: HeldMessage): HeldMessageDto {
  return {
    idx: held.idx,
    body: held.body,
    properties: held.properties as Record<string, unknown>,
    applicationProperties: held.applicationProperties,
    xDeath: held.xDeath.map(toXDeathDto),
  };
}

function toXDeathDto(x: XDeath): XDeathDto {
  return {
    queue: x.queue,
    reason: x.reason,
    count: x.count,
    exchange: x.exchange,
    'routing-keys': x['routing-keys'] ?? [],
    'first-time': x['first-time'],
    'last-time': x['last-time'],
  };
}
