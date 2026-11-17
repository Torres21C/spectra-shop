import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReservationLineDto {
  @IsUUID('4')
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;

  @Matches(/^\d{1,8}\.\d{2}$/)
  expectedUnitPrice!: string;
}

export class CreateReservationDto {
  @IsUUID('4')
  reservationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReservationLineDto)
  lines!: ReservationLineDto[];
}

export class ReservationIdDto {
  @IsUUID('4')
  reservationId!: string;
}

/** DT-08: cuerpo de `fulfill`. La pareja reservationId + orderId es la clave natural de idempotencia. */
export class FulfillReservationDto {
  @IsUUID('4')
  orderId!: string;
}

/** DT-08: parámetros acotados del reporte de reservas confirmadas sin reconocimiento. */
export class UnfulfilledQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(604_800)
  olderThanSeconds?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
