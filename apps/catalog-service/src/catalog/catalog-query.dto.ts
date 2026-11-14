import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CatalogQueryDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 50, example: 'teclado' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, 50)
  search?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 64, example: 'audio' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  category?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 10_000, default: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;
}

export class ProductIdDto {
  @ApiProperty({ format: 'uuid', example: '20000000-0000-4000-8000-000000000003' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  id!: string;
}
