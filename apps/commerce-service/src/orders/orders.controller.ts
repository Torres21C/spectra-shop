import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { OrderDetail, OrderHistoryPage } from '@spectra/contracts';
import { CartAccessGuard } from '../auth/cart-access.guard.js';
import { OrderIdDto } from '../checkout/checkout.dto.js';
import type { CommerceRequest } from '../common/request-context.js';
import { OrderHistoryQueryDto } from './orders.dto.js';
import { OrdersService } from './orders.service.js';

/**
 * M05 Gestión de pedidos (cliente). Solo CLIENTE con JWT ES256 válido y sesión activa en Identity
 * (CartAccessGuard). Sin rutas de modificación ni cancelación (RN-22). Las respuestas viajan con
 * `Cache-Control: no-store` (NoStoreMiddleware, D-M05-06).
 */
@ApiTags('Pedidos del cliente')
@ApiCookieAuth('access-cookie')
@UseGuards(CartAccessGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({
    summary: 'Historial de pedidos propios, del más reciente al más antiguo (RF-026)',
    description: 'Paginación del servidor con tamaño fijo de 10; solo se acepta `page`.',
  })
  @ApiOkResponse({ description: 'Página del historial; vacía si el cliente no tiene pedidos' })
  @ApiBadRequestResponse({ description: 'Página inválida o parámetro no declarado' })
  @ApiUnauthorizedResponse({ description: 'Sesión ausente, inválida, revocada o expirada' })
  @ApiForbiddenResponse({ description: 'El rol ADMIN consulta pedidos en M06' })
  @ApiServiceUnavailableResponse({ description: 'Identity no disponible' })
  history(
    @Query() query: OrderHistoryQueryDto,
    @Req() request: CommerceRequest,
  ): Promise<OrderHistoryPage> {
    return this.orders.history(request.auth!.userId, query.page);
  }

  @Get(':orderId')
  @ApiOperation({
    summary:
      'Detalle de un pedido propio con precios congelados y línea de tiempo (RF-027, RF-028)',
  })
  @ApiOkResponse({ description: 'Pedido, estado vigente con su fecha y línea de tiempo' })
  @ApiBadRequestResponse({ description: 'El identificador no es un UUID v4' })
  @ApiNotFoundResponse({ description: 'Pedido ajeno o inexistente (respuesta uniforme, RF-029)' })
  @ApiUnauthorizedResponse({ description: 'Sesión ausente, inválida, revocada o expirada' })
  @ApiForbiddenResponse({ description: 'El rol ADMIN consulta pedidos en M06' })
  detail(@Param() params: OrderIdDto, @Req() request: CommerceRequest): Promise<OrderDetail> {
    return this.orders.detail(
      {
        userId: request.auth!.userId,
        role: request.auth!.role,
        requestId: request.requestId,
        sourceIp: request.ip,
      },
      params.orderId,
    );
  }
}
