import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { CategorySummary, ProductDetail, ProductPage } from '@spectra/contracts';
import { CatalogQueryDto, ProductIdDto } from './catalog-query.dto.js';
import {
  ApiErrorResponseDto,
  CategoryResponseDto,
  ProductDetailResponseDto,
  ProductPageResponseDto,
} from './catalog-response.dto.js';
import { CatalogService } from './catalog.service.js';

@ApiTags('catalog')
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  @ApiOperation({ summary: 'Lista las categorías activas' })
  @ApiOkResponse({ type: [CategoryResponseDto] })
  listCategories(): Promise<CategorySummary[]> {
    return this.catalog.listCategories();
  }

  @Get('products')
  @ApiOperation({ summary: 'Lista, busca y filtra productos activos' })
  @ApiOkResponse({ type: ProductPageResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  listProducts(@Query() query: CatalogQueryDto): Promise<ProductPage> {
    return this.catalog.listProducts(query);
  }

  @Get('products/:id')
  @ApiOperation({ summary: 'Obtiene el detalle público de un producto activo' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto })
  getProduct(@Param() params: ProductIdDto): Promise<ProductDetail> {
    return this.catalog.getProduct(params.id);
  }
}
