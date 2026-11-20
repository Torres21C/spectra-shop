import { Module, type Provider } from '@nestjs/common';
import { jwtSignerConfig } from '../config/identity.config.js';
import { AccessGuard } from './access.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AwsKmsSigningClient } from './aws-kms-signing.client.js';
import { CookieService } from './cookie.service.js';
import { CsrfService } from './csrf.service.js';
import { DevelopmentEs256Adapter } from './development-es256.adapter.js';
import { JWT_CRYPTO_PORT, type JwtCryptoPort } from './jwt-crypto.port.js';
import { KmsEs256Adapter } from './kms-es256.adapter.js';
import { PasswordService } from './password.service.js';
import { RolesGuard } from './roles.guard.js';
import { TokenService } from './token.service.js';

/** AD-08: KMS en AWS (IDENTITY_JWT_SIGNER=kms); claves PEM locales en desarrollo y pruebas. */
export const jwtCryptoProvider: Provider = {
  provide: JWT_CRYPTO_PORT,
  useFactory: (): JwtCryptoPort => {
    const signer = jwtSignerConfig();
    return signer.mode === 'kms'
      ? new KmsEs256Adapter(new AwsKmsSigningClient(), signer.keyId)
      : new DevelopmentEs256Adapter();
  },
};

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    jwtCryptoProvider,
    TokenService,
    CookieService,
    CsrfService,
    AccessGuard,
    RolesGuard,
  ],
  exports: [AuthService, AccessGuard, RolesGuard],
})
export class AuthModule {}
