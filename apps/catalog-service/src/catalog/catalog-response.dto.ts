import { ApiProperty } from '@nestjs/swagger';

export class CategoryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'audio' })
  slug!: string;

  @ApiProperty({ example: 'Audio' })
  name!: string;
}

export class ProductResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Audífonos Nebula' })
  name!: string;

  @ApiProperty({ example: 'Audífonos circumaurales con micrófono desmontable.' })
  description!: string;

  @ApiProperty({ type: CategoryResponseDto })
  category!: CategoryResponseDto;

  @ApiProperty({ example: '799.00', description: 'Precio final con IVA incluido' })
  price!: string;

  @ApiProperty({ enum: ['GTQ'], example: 'GTQ' })
  currency!: 'GTQ';

  @ApiProperty({ enum: ['OUT_OF_STOCK', 'LOW_STOCK', 'AVAILABLE'] })
  availability!: 'OUT_OF_STOCK' | 'LOW_STOCK' | 'AVAILABLE';

  @ApiProperty({ example: 'headphones' })
  imageKey!: string;
}

export class ProductDetailResponseDto extends ProductResponseDto {
  @ApiProperty({ example: 'SP-AUD-001' })
  sku!: string;
}

class PageMetaResponseDto {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 12 })
  pageSize!: number;

  @ApiProperty({ example: 12 })
  totalItems!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

export class ProductPageResponseDto {
  @ApiProperty({ type: [ProductResponseDto] })
  items!: ProductResponseDto[];

  @ApiProperty({ type: PageMetaResponseDto })
  meta!: PageMetaResponseDto;
}

export class ApiErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'VALIDATION_ERROR' })
  code!: string;

  @ApiProperty({ example: 'Parámetros inválidos' })
  message!: string;

  @ApiProperty({ format: 'uuid' })
  requestId!: string;

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;
}
