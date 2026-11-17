import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminAccessGuard, type AdminRequest, assertCsrf } from './admin-access.guard.js';
import { type AdminProductCreated, CreateProductDto } from './admin-products.dto.js';
import { AdminProductsService } from './admin-products.service.js';

/** M06 mínimo: solo alta de productos (sin edición, desactivación ni ajustes de inventario). */
@ApiTags('Administración')
@ApiCookieAuth('access-cookie')
@UseGuards(AdminAccessGuard)
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly products: AdminProductsService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Crea un producto activo y registra PRODUCT_CREATED (RF-030)' })
  @ApiCreatedResponse({ description: 'Producto creado' })
  @ApiBadRequestResponse({ description: 'Campo inválido, no declarado o categoría inexistente' })
  @ApiUnauthorizedResponse({ description: 'Sesión ausente, inválida o expirada' })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN, CSRF u Origin inválidos' })
  @ApiConflictResponse({ description: 'SKU duplicado' })
  create(
    @Body() dto: CreateProductDto,
    @Req() request: AdminRequest,
  ): Promise<AdminProductCreated> {
    assertCsrf(request);
    return this.products.create(dto, {
      ...request.auth!,
      requestId: request.requestId,
      sourceIp: request.ip,
    });
  }
}
