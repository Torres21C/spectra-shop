import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { InternalSessionController } from './auth/internal-session.controller.js';
import { InternalServiceGuard } from './common/internal-service.guard.js';
import { DatabaseModule } from './database/database.module.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [InternalSessionController],
  providers: [InternalServiceGuard],
})
export class InternalAppModule {}
