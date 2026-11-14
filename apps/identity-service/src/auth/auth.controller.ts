import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { IdentityRequest } from '../common/request-context.js';
import { AuthException } from '../common/auth.exception.js';
import { AccessGuard } from './access.guard.js';
import { AuthService } from './auth.service.js';
import { CookieService } from './cookie.service.js';
import { CsrfService } from './csrf.service.js';
import { LoginDto, ProfileQueryDto, RegisterDto } from './auth.dto.js';

@ApiTags('Identidad')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly csrf: CsrfService,
    private readonly cookies: CookieService,
  ) {}

  @Get('csrf')
  @ApiOperation({ summary: 'Emite un token CSRF de doble envío' })
  csrfToken(@Res({ passthrough: true }) response: Response): { csrfToken: string } {
    return { csrfToken: this.csrf.issue(response) };
  }

  @Post('register')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Registra exclusivamente clientes' })
  async register(@Body() dto: RegisterDto, @Req() request: IdentityRequest) {
    this.csrf.assert(request);
    const access = request.cookies?.[this.cookies.names.access] as unknown;
    if (typeof access === 'string') {
      try {
        await this.auth.authenticate(access);
        throw new AuthException(403, 'AUTH_REQUIRED', 'Solicitud rechazada');
      } catch (error: unknown) {
        if (error instanceof AuthException && error.getStatus() === 403) throw error;
      }
    }
    return this.auth.register(dto, request.requestId);
  }

  @Post('login')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Inicia una sesión segura' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.csrf.assert(request);
    const result = await this.auth.login(dto, request.requestId);
    this.cookies.setSession(response, result.accessToken, result.refreshToken);
    return { user: result.user, returnTo: result.returnTo };
  }

  @Post('refresh')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rota el refresh token' })
  async refresh(
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ refreshed: true }> {
    this.csrf.assert(request);
    const raw = request.cookies?.[this.cookies.names.refresh] as unknown;
    if (typeof raw !== 'string') {
      throw new AuthException(401, 'AUTH_REQUIRED', 'Autenticación requerida');
    }
    const result = await this.auth.refresh(raw, request.requestId);
    this.cookies.setSession(response, result.accessToken, result.refreshToken);
    return { refreshed: true };
  }

  @Post('logout')
  @UseGuards(AccessGuard)
  @ApiOperation({ summary: 'Revoca la sesión actual' })
  async logout(
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ loggedOut: true }> {
    this.csrf.assert(request);
    await this.auth.logout(request.auth!, request.requestId);
    this.cookies.clearSession(response);
    return { loggedOut: true };
  }

  @Get('me')
  @UseGuards(AccessGuard)
  @ApiOperation({ summary: 'Obtiene exclusivamente el perfil de la sesión' })
  me(@Req() request: IdentityRequest, @Query() query: ProfileQueryDto) {
    void query;
    return this.auth.profile(request.auth!);
  }
}
