import { Module } from '@nestjs/common';
import { CartAccessGuard } from '../auth/cart-access.guard.js';
import { CsrfService } from '../auth/csrf.service.js';
import { IdentityClientService } from '../auth/identity-client.service.js';
import { JwtVerifierService } from '../auth/jwt-verifier.service.js';
import { CatalogClientService } from '../catalog/catalog-client.service.js';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';

@Module({
  controllers: [CartController],
  providers: [
    CartService,
    CatalogClientService,
    JwtVerifierService,
    IdentityClientService,
    CartAccessGuard,
    CsrfService,
  ],
})
export class CartModule {}
