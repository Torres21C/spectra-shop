import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { CheckoutSummary, OrderConfirmation } from '@spectra/contracts';
import type { Response } from 'express';
import { CartAccessGuard } from '../auth/cart-access.guard.js';
import { CsrfService } from '../auth/csrf.service.js';
import type { AuditActor } from '../common/outbox.service.js';
import type { CommerceRequest } from '../common/request-context.js';
import { OrderIdDto, PlaceOrderDto } from './checkout.dto.js';
import { UUID_V4 } from './checkout.helpers.js';
import { CheckoutService } from './checkout.service.js';

function actorOf(request: CommerceRequest): AuditActor {
  return {
    userId: request.auth!.userId,
    role: request.auth!.role,
    requestId: request.requestId,
    sourceIp: request.ip,
  };
}

/** M04 Checkout. Solo CLIENTE con JWT ES256 válido y sesión activa en Identity. */
@ApiTags('Checkout y pedidos')
@ApiCookieAuth('access-cookie')
@UseGuards(CartAccessGuard)
@Controller()
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly csrf: CsrfService,
  ) {}

  @Get('checkout/summary')
  @ApiOperation({ summary: 'Resumen recalculado en servidor con huella para confirmar (RF-020)' })
  @ApiOkResponse({
    description: 'Resumen, total y huella; checkoutAllowed indica si se puede pagar',
  })
  @ApiConflictResponse({ description: 'Carrito vacío' })
  @ApiUnauthorizedResponse({ description: 'Sesión ausente, inválida, revocada o expirada' })
  @ApiForbiddenResponse({ description: 'El rol ADMIN no puede comprar' })
  @ApiServiceUnavailableResponse({ description: 'Identity o Catalog no disponible' })
  summary(@Req() request: CommerceRequest): Promise<CheckoutSummary> {
    return this.checkout.summary(request.auth!.userId, request.requestId);
  }

  @Post('orders')
  @ApiOperation({
    summary: 'Confirma el pedido con pago simulado, idempotente por Idempotency-Key',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4 por intento' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiCreatedResponse({ description: 'Pedido PAGADO creado' })
  @ApiOkResponse({ description: 'Reenvío con la misma clave: pedido existente' })
  @ApiBadRequestResponse({ description: 'DTO inválido, campo no declarado o clave ausente' })
  @ApiConflictResponse({
    description: 'Stock insuficiente, resumen cambiado, carrito vacío o checkout en curso',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Pago simulado rechazado o clave reutilizada con otro contenido',
  })
  @ApiTooManyRequestsResponse({ description: 'Límite de intentos por cuenta' })
  @ApiServiceUnavailableResponse({ description: 'Saga pendiente o dependencia no disponible' })
  async place(
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() dto: PlaceOrderDto,
    @Req() request: CommerceRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderConfirmation> {
    this.csrf.assert(request);
    if (typeof rawKey !== 'string' || !UUID_V4.test(rawKey)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key debe ser un UUID v4',
      });
    }
    const outcome = await this.checkout.place(actorOf(request), rawKey.toLowerCase(), dto);
    response.status(outcome.status);
    return outcome.order;
  }

  @Get('orders/:orderId')
  @ApiOperation({ summary: 'Confirmación de un pedido propio (pantalla P06)' })
  @ApiOkResponse({ description: 'Pedido con precios congelados' })
  @ApiNotFoundResponse({ description: 'Pedido ajeno o inexistente (respuesta uniforme)' })
  order(@Param() params: OrderIdDto, @Req() request: CommerceRequest): Promise<OrderConfirmation> {
    return this.checkout.order(actorOf(request), params.orderId);
  }
}
