import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * GET /orders (RF-026). Solo se admite `page`: el tamaño es fijo (D-M05-04) y el propietario sale de
 * la sesión, nunca de la consulta. `pageSize`, `limit`, `userId`… se rechazan con 400 por lista blanca.
 */
export class OrderHistoryQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 10_000, default: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;
}
