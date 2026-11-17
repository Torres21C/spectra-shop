import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { AdminAccessGuard } from './admin-access.guard.js';
import { AdminProductsController } from './admin-products.controller.js';
import { AdminProductsService } from './admin-products.service.js';
import { AuditRelayService } from './audit-relay.service.js';
import { IdentityClientService } from './identity-client.service.js';
import { JwtVerifierService } from './jwt-verifier.service.js';

@Module({
  // Reutiliza el PrismaService exportado por CatalogModule (un solo pool de conexiones).
  imports: [CatalogModule],
  controllers: [AdminProductsController],
  providers: [
    AdminProductsService,
    AdminAccessGuard,
    JwtVerifierService,
    IdentityClientService,
    AuditRelayService,
  ],
  exports: [AuditRelayService],
})
export class AdminModule {}
