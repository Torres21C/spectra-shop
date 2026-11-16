import { Injectable, NotFoundException } from '@nestjs/common';
import type { OrderDetail, OrderHistoryPage } from '@spectra/contracts';
import { type AuditActor, OutboxService } from '../common/outbox.service.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  ORDER_HISTORY_PAGE_SIZE,
  ORDER_SUMMARY_SELECT,
  presentDetail,
  presentSummary,
  totalPages,
} from './orders.helpers.js';

/** M05 Gestión de pedidos del cliente. Solo lectura: el cliente no modifica ni cancela (RN-22). */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /** RF-026 / CA-M05-01: el filtro de propiedad forma parte de la consulta (RN-20, RS02). */
  async history(userId: string, page: number): Promise<OrderHistoryPage> {
    const where = { userId };
    const [totalItems, orders] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        // Orden estable: más reciente primero y desempate por id para no repetir ni omitir filas.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * ORDER_HISTORY_PAGE_SIZE,
        take: ORDER_HISTORY_PAGE_SIZE,
        select: ORDER_SUMMARY_SELECT,
      }),
    ]);
    return {
      items: orders.map(presentSummary),
      meta: {
        page,
        pageSize: ORDER_HISTORY_PAGE_SIZE,
        totalItems,
        totalPages: totalPages(totalItems),
      },
    };
  }

  /**
   * RF-027/RF-028/RF-029: detalle de un pedido propio. Pedido ajeno o inexistente responden igual
   * (404 `ORDER_NOT_FOUND`, CA-M05-02); el intento sobre un pedido ajeno queda como `ACCESS_DENIED`
   * en la outbox hasta que M07 lo entregue a audit-service (D-M05-05).
   */
  async detail(actor: AuditActor, orderId: string): Promise<OrderDetail> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId: actor.userId },
      include: { items: { orderBy: { productId: 'asc' } } },
    });
    if (order) return presentDetail(order);
    const foreign = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (foreign) {
      await this.outbox.record(actor, {
        eventType: 'ACCESS_DENIED',
        result: 'DENEGADO',
        resourceType: 'order',
        resourceId: orderId,
        metadata: { operation: 'GET /orders/:id' },
      });
    }
    throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Pedido no encontrado' });
  }
}
