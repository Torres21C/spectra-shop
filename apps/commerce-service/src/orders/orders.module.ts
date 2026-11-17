import { Module } from '@nestjs/common';
import { AdminAccessGuard } from '../auth/admin-access.guard.js';
import { CartAccessGuard } from '../auth/cart-access.guard.js';
import { IdentityClientService } from '../auth/identity-client.service.js';
import { JwtVerifierService } from '../auth/jwt-verifier.service.js';
import { OutboxService } from '../common/outbox.service.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  controllers: [OrdersController, AdminOrdersController],
  providers: [
    OrdersService,
    OutboxService,
    JwtVerifierService,
    IdentityClientService,
    CartAccessGuard,
    AdminAccessGuard,
  ],
})
export class OrdersModule {}
