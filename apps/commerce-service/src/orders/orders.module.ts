import { Module } from '@nestjs/common';
import { CartAccessGuard } from '../auth/cart-access.guard.js';
import { IdentityClientService } from '../auth/identity-client.service.js';
import { JwtVerifierService } from '../auth/jwt-verifier.service.js';
import { OutboxService } from '../common/outbox.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OutboxService,
    JwtVerifierService,
    IdentityClientService,
    CartAccessGuard,
  ],
})
export class OrdersModule {}
