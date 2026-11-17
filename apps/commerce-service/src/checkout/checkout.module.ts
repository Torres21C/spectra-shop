import { Module } from '@nestjs/common';
import { CartAccessGuard } from '../auth/cart-access.guard.js';
import { CsrfService } from '../auth/csrf.service.js';
import { IdentityClientService } from '../auth/identity-client.service.js';
import { JwtVerifierService } from '../auth/jwt-verifier.service.js';
import { CatalogClientService } from '../catalog/catalog-client.service.js';
import { InventoryClientService } from '../catalog/inventory-client.service.js';
import { OutboxService } from '../common/outbox.service.js';
import { CheckoutRecoveryService } from './checkout-recovery.service.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { InventoryFulfillmentRecoveryService } from './inventory-fulfillment-recovery.service.js';
import { InventoryFulfillmentService } from './inventory-fulfillment.service.js';

@Module({
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    CheckoutRecoveryService,
    InventoryFulfillmentService,
    InventoryFulfillmentRecoveryService,
    CatalogClientService,
    InventoryClientService,
    OutboxService,
    JwtVerifierService,
    IdentityClientService,
    CartAccessGuard,
    CsrfService,
  ],
  exports: [
    CheckoutService,
    CheckoutRecoveryService,
    InventoryFulfillmentService,
    InventoryFulfillmentRecoveryService,
  ],
})
export class CheckoutModule {}
