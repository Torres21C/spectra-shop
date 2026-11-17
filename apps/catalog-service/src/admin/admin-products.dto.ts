import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Texto plano sin caracteres de control (RN-27): se guarda literal y la Web lo muestra escapado. */
const PLAIN_TEXT = /^[^\p{Cc}]*$/u;

/**
 * M06 mínimo (RF-030): alta de producto. Lista blanca estricta: el ValidationPipe global rechaza
 * cualquier campo no declarado (id, isActive, imageKey, searchText, fechas…).
 */
export class CreateProductDto {
  @ApiProperty({ pattern: '^[A-Z0-9-]{4,20}$', example: 'SP-DEMO-001' })
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Z0-9-]{4,20}$/)
  sku!: string;

  @ApiProperty({ minLength: 3, maxLength: 100, example: 'Teclado Demo' })
  @Transform(trim)
  @IsString()
  @Length(3, 100)
  @Matches(PLAIN_TEXT)
  name!: string;

  @ApiPropertyOptional({ maxLength: 1000, default: '' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 1000)
  @Matches(PLAIN_TEXT)
  description?: string;

  @ApiProperty({ format: 'uuid', example: '10000000-0000-4000-8000-000000000001' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: '199.90', description: 'GTQ, 0.01–99999.99 con hasta 2 decimales' })
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/)
  price!: string;

  @ApiProperty({ minimum: 0, maximum: 9999, example: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  stock!: number;
}

export interface AdminProductCreated {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly price: string;
  readonly stock: number;
  readonly isActive: boolean;
  readonly category: { readonly id: string; readonly slug: string; readonly name: string };
}
