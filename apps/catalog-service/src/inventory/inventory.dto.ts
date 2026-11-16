import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
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
