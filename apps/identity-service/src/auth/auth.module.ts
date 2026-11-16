import { Module } from '@nestjs/common';
import { AccessGuard } from './access.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CookieService } from './cookie.service.js';
import { CsrfService } from './csrf.service.js';
import { DevelopmentEs256Adapter } from './development-es256.adapter.js';
import { JWT_CRYPTO_PORT } from './jwt-crypto.port.js';
import { PasswordService } from './password.service.js';
import { RolesGuard } from './roles.guard.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    { provide: JWT_CRYPTO_PORT, useClass: DevelopmentEs256Adapter },
    TokenService,
    CookieService,
    CsrfService,
    AccessGuard,
    RolesGuard,
  ],
  exports: [AuthService, AccessGuard, RolesGuard],
})
export class AuthModule {}
