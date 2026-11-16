import { Controller, Headers, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { ValidatedSession } from '@spectra/contracts';
import { InternalServiceGuard } from '../common/internal-service.guard.js';
import { AuthService } from './auth.service.js';

@ApiExcludeController()
@Controller('internal/sessions')
@UseGuards(InternalServiceGuard)
export class InternalSessionController {
  constructor(private readonly auth: AuthService) {}

  @Post('validate-touch')
  async validateTouch(@Headers('authorization') authorization?: string): Promise<ValidatedSession> {
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization ?? '');
    if (!match?.[1]) throw new UnauthorizedException();
    const principal = await this.auth.authenticate(match[1]);
    return {
      userId: principal.userId,
      sessionId: principal.sessionId,
      role: principal.role,
    };
  }
}
