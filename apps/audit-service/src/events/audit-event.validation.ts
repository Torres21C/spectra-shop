import { BadRequestException } from '@nestjs/common';

/**
 * M07 mínimo: lista cerrada de orígenes y de tipos de evento aceptados. Ampliarla (Identity,
 * Commerce, eventos de M06 posteriores) es un cambio explícito y revisable.
 */
const ACCEPTED: Readonly<Record<string, ReadonlySet<string>>> = {
  catalog: new Set(['PRODUCT_CREATED']),
};
const RESULTS = new Set(['EXITO', 'FALLO', 'DENEGADO']);
const ROLES = new Set(['CLIENTE', 'ADMIN']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METADATA_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
/** RN-30: red de seguridad; ningún metadato puede llamarse como un secreto o dato de sesión. */
const FORBIDDEN_KEY = /pass|token|cookie|secret|authorization|session|hash|card|address|phone/i;
const MAX_EVENTS = 100;

export interface IngestEvent {
  readonly id: string;
  readonly sourceService: string;
  readonly eventType: string;
  readonly result: string;
  readonly actorId: string | null;
  readonly actorRole: string | null;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly sourceIp: string | null;
  readonly requestId: string | null;
  readonly metadata: Record<string, string | number | boolean | null>;
  readonly occurredAt: Date;
}

function invalid(): never {
  throw new BadRequestException({
    code: 'INVALID_AUDIT_EVENT',
    message: 'Evento de auditoría inválido',
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function optionalUuid(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}

function metadata(value: unknown): IngestEvent['metadata'] {
  const source = record(value);
  const entries = Object.entries(source);
  if (entries.length > 20) invalid();
  const result: IngestEvent['metadata'] = {};
  for (const [key, item] of entries) {
    if (!METADATA_KEY.test(key) || FORBIDDEN_KEY.test(key)) invalid();
    if (typeof item === 'string') {
      if (item.length > 200) invalid();
    } else if (
      !(typeof item === 'number' && Number.isFinite(item)) &&
      typeof item !== 'boolean' &&
      item !== null
    ) {
      invalid();
    }
    result[key] = item;
  }
  return result;
}

const ALLOWED_FIELDS = new Set([
  'id',
  'sourceService',
  'eventType',
  'result',
  'actorId',
  'actorRole',
  'resourceType',
  'resourceId',
  'sourceIp',
  'requestId',
  'metadata',
  'occurredAt',
]);

/** Valida un lote de ingesta completo; cualquier evento inválido rechaza el lote (400). */
export function parseIngestBatch(body: unknown): IngestEvent[] {
  const root = record(body);
  if (Object.keys(root).some((key) => key !== 'events')) invalid();
  const events = root['events'];
  if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS) invalid();
  return events.map((raw: unknown) => {
    const event = record(raw);
    if (Object.keys(event).some((key) => !ALLOWED_FIELDS.has(key))) invalid();
    const id = optionalUuid(event['id']);
    const sourceService = event['sourceService'];
    const eventType = event['eventType'];
    if (
      id === null ||
      typeof sourceService !== 'string' ||
      typeof eventType !== 'string' ||
      !ACCEPTED[sourceService]?.has(eventType)
    ) {
      invalid();
    }
    const result = event['result'];
    if (typeof result !== 'string' || !RESULTS.has(result)) invalid();
    const actorRole = event['actorRole'] ?? null;
    if (actorRole !== null && (typeof actorRole !== 'string' || !ROLES.has(actorRole))) invalid();
    const resourceType = event['resourceType'];
    if (typeof resourceType !== 'string' || !/^[a-z_]{1,40}$/.test(resourceType)) invalid();
    const sourceIp = event['sourceIp'] ?? null;
    if (sourceIp !== null && (typeof sourceIp !== 'string' || sourceIp.length > 64)) invalid();
    const occurredAt =
      typeof event['occurredAt'] === 'string' ? new Date(event['occurredAt']) : null;
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) invalid();
    return {
      id,
      sourceService,
      eventType,
      result,
      actorId: optionalUuid(event['actorId']),
      actorRole: actorRole,
      resourceType,
      resourceId: optionalUuid(event['resourceId']),
      sourceIp: sourceIp,
      requestId: optionalUuid(event['requestId']),
      metadata: metadata(event['metadata']),
      occurredAt,
    };
  });
}
