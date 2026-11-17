import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdminAccessGuard } from '../auth/admin-access.guard.js';
import { InternalTokenGuard } from '../auth/internal-token.guard.js';
import { parseIngestBatch } from './audit-event.validation.js';
import { type AuditEventView, AuditEventsService } from './audit-events.service.js';

export class LatestEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

/**
 * M07 mínimo: consulta de solo lectura para ADMIN (RF-042 reducido: últimos eventos, sin filtros).
 * No existe ninguna ruta de modificación ni de borrado (RN-31, CA-M07-03).
 */
@UseGuards(AdminAccessGuard)
@Controller('admin/audit-events')
export class AdminAuditEventsController {
  constructor(private readonly events: AuditEventsService) {}

  @Get()
  async latest(@Query() query: LatestEventsQueryDto): Promise<{ items: AuditEventView[] }> {
    return { items: await this.events.latest(query.limit) };
  }
}

/** Ingesta interna (solo red privada de Compose + token de servicio). */
@UseGuards(InternalTokenGuard)
@Controller('internal/audit/events')
export class InternalAuditEventsController {
  constructor(private readonly events: AuditEventsService) {}

  @Post()
  @HttpCode(202)
  ingest(@Body() body: unknown): Promise<{ received: number; inserted: number }> {
    return this.events.ingest(parseIngestBatch(body));
  }
}
