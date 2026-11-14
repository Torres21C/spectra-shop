import { Injectable } from '@nestjs/common';
import type { LoginDto, RegisterDto } from './auth.dto.js';
import { AuthException } from '../common/auth.exception.js';
import type { AuthPrincipal } from '../common/request-context.js';
import { identityConfig } from '../config/identity.config.js';
import { PrismaService } from '../database/prisma.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

const REGISTRATION_MESSAGE = 'Si los datos son válidos, el registro ha sido procesado';
const INVALID_LOGIN_MESSAGE = 'Correo o contraseña incorrectos';

function safeReturnTo(value: string | undefined): string {
  if (!value) return '#/';
  if (/^#\/[A-Za-z0-9/_-]*$/.test(value)) return value;
  if (/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(value)) return value;
  return '#/';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async register(dto: RegisterDto, requestId: string): Promise<{ message: string }> {
    if (!dto.academicDataAccepted)
      throw new AuthException(400, 'VALIDATION_ERROR', 'Parámetros inválidos');
    this.passwords.validateForRegistration(dto.password, dto.passwordConfirmation, dto.email);
    const passwordHash = await this.passwords.hash(dto.password);
    const existing = await this.prisma.user.findUnique({ where: { emailNormalized: dto.email } });
    if (existing) {
      await this.audit('AUTH_REGISTER', 'FALLO', undefined, requestId, { reason: 'not_created' });
      return { message: REGISTRATION_MESSAGE };
    }

    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: 'CLIENTE' } });
    try {
      const user = await this.prisma.user.create({
        data: {
          roleId: role.id,
          fullName: dto.fullName,
          emailNormalized: dto.email,
          passwordHash,
        },
      });
      await this.audit('AUTH_REGISTER', 'EXITO', user.id, requestId, { role: 'CLIENTE' });
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'P2002') {
        await this.audit('AUTH_REGISTER', 'FALLO', undefined, requestId, { reason: 'not_created' });
        return { message: REGISTRATION_MESSAGE };
      }
      throw error;
    }
    return { message: REGISTRATION_MESSAGE };
  }

  async login(
    dto: LoginDto,
    requestId: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      fullName: string;
      email: string;
      role: 'CLIENTE' | 'ADMIN';
      createdAt: string;
    };
    returnTo: string;
  }> {
    const now = new Date();
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: dto.email },
      include: { role: true },
    });

    if (user?.lockedUntil && user.lockedUntil > now) {
      await this.audit('AUTH_LOCKOUT', 'DENEGADO', user.id, requestId, {});
      throw new AuthException(429, 'AUTH_LOCKOUT', 'Acceso temporalmente bloqueado');
    }

    const passwordValid = user
      ? await this.passwords.verify(user.passwordHash, dto.password)
      : (await this.passwords.verifyDummy(dto.password), false);
    if (!user || !user.isActive || !passwordValid) {
      if (user) await this.recordFailure(user.id, now);
      await this.audit('AUTH_LOGIN_FAILURE', 'FALLO', user?.id, requestId, {});
      throw new AuthException(401, 'AUTH_INVALID', INVALID_LOGIN_MESSAGE);
    }

    const role = user.role.code === 'ADMIN' ? 'ADMIN' : 'CLIENTE';
    const refreshToken = this.tokens.newRefreshToken();
    const familyId = crypto.randomUUID();
    const absoluteExpiresAt = new Date(now.getTime() + identityConfig.absoluteSessionMs);
    const session = await this.prisma.$transaction(async (transaction) => {
      await transaction.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          failedLoginWindowStarted: null,
          lockedUntil: null,
          lastLoginAt: now,
        },
      });
      const created = await transaction.authSession.create({
        data: { userId: user.id, lastActivityAt: now, absoluteExpiresAt },
      });
      await transaction.refreshToken.create({
        data: {
          sessionId: created.id,
          tokenHash: this.tokens.hashRefreshToken(refreshToken),
          familyId,
          expiresAt: absoluteExpiresAt,
        },
      });
      await transaction.outboxEvent.create({
        data: {
          eventType: 'AUTH_LOGIN_SUCCESS',
          result: 'EXITO',
          actorId: user.id,
          requestId,
          metadata: { role },
        },
      });
      return created;
    });
    const accessToken = await this.tokens.signAccess(user.id, session.id, role);
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.emailNormalized,
        role,
        createdAt: user.createdAt.toISOString(),
      },
      returnTo: safeReturnTo(dto.returnTo),
    };
  }

  async authenticate(accessToken: string): Promise<AuthPrincipal> {
    try {
      const claims = await this.tokens.verifyAccess(accessToken);
      const session = await this.assertSession(claims.sid, true);
      if (session.userId !== claims.sub || session.user.role.code !== claims.role)
        throw new Error();
      return { userId: claims.sub, sessionId: claims.sid, role: claims.role };
    } catch (error: unknown) {
      if (error instanceof AuthException) throw error;
      throw new AuthException(401, 'AUTH_REQUIRED', 'Autenticación requerida');
    }
  }

  async profile(principal: AuthPrincipal) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      include: { role: true },
    });
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.emailNormalized,
      role: user.role.code === 'ADMIN' ? ('ADMIN' as const) : ('CLIENTE' as const),
      createdAt: user.createdAt.toISOString(),
    };
  }

  async refresh(rawToken: string, requestId: string) {
    const tokenHash = this.tokens.hashRefreshToken(rawToken);
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: { include: { user: { include: { role: true } } } } },
    });
    if (!current) throw new AuthException(401, 'AUTH_REQUIRED', 'Autenticación requerida');
    if (current.usedAt || current.revokedAt) {
      await this.revokeSession(current.sessionId, 'REFRESH_REUSE');
      throw new AuthException(401, 'AUTH_REQUIRED', 'Autenticación requerida');
    }
    const session = await this.assertSession(current.sessionId, true);
    const now = new Date();
    if (current.expiresAt <= now) {
      await this.revokeSession(current.sessionId, 'REFRESH_EXPIRED');
      throw new AuthException(401, 'SESSION_EXPIRED', 'La sesión ha expirado');
    }
    const nextToken = this.tokens.newRefreshToken();
    const next = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.refreshToken.updateMany({
        where: { id: current.id, usedAt: null, revokedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return undefined;
      const created = await transaction.refreshToken.create({
        data: {
          sessionId: current.sessionId,
          familyId: current.familyId,
          tokenHash: this.tokens.hashRefreshToken(nextToken),
          expiresAt: session.absoluteExpiresAt,
        },
      });
      await transaction.refreshToken.update({
        where: { id: current.id },
        data: { replacedById: created.id },
      });
      return created;
    });
    if (!next) {
      await this.revokeSession(current.sessionId, 'REFRESH_REUSE');
      throw new AuthException(401, 'AUTH_REQUIRED', 'Autenticación requerida');
    }
    const role = session.user.role.code === 'ADMIN' ? 'ADMIN' : 'CLIENTE';
    return {
      accessToken: await this.tokens.signAccess(session.userId, session.id, role),
      refreshToken: nextToken,
      requestId,
    };
  }

  async logout(principal: AuthPrincipal, requestId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.authSession.updateMany({
        where: { id: principal.sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'LOGOUT' },
      }),
      this.prisma.refreshToken.updateMany({
        where: { sessionId: principal.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.outboxEvent.create({
        data: {
          eventType: 'AUTH_LOGOUT',
          result: 'EXITO',
          actorId: principal.userId,
          requestId,
          metadata: {},
        },
      }),
    ]);
  }

  private async recordFailure(userId: string, now: Date): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const windowActive =
      user.failedLoginWindowStarted !== null &&
      now.getTime() - user.failedLoginWindowStarted.getTime() <= identityConfig.lockWindowMs;
    const count = windowActive ? user.failedLoginCount + 1 : 1;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: count,
        failedLoginWindowStarted: windowActive ? user.failedLoginWindowStarted : now,
        lockedUntil: count >= 5 ? new Date(now.getTime() + identityConfig.lockDurationMs) : null,
      },
    });
  }

  private async assertSession(sessionId: string, touch: boolean) {
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      include: { user: { include: { role: true } } },
    });
    const now = new Date();
    const expired =
      !session ||
      session.revokedAt !== null ||
      session.absoluteExpiresAt <= now ||
      now.getTime() - session.lastActivityAt.getTime() > identityConfig.inactivityMs;
    if (expired) {
      if (session && !session.revokedAt) {
        await this.prisma.$transaction([
          this.prisma.authSession.update({
            where: { id: session.id },
            data: { revokedAt: now, revokeReason: 'EXPIRED' },
          }),
          this.prisma.outboxEvent.create({
            data: {
              eventType: 'SESSION_EXPIRED',
              result: 'EXITO',
              actorId: session.userId,
              metadata: {},
            },
          }),
        ]);
      }
      throw new AuthException(401, 'SESSION_EXPIRED', 'La sesión ha expirado');
    }
    if (touch && now.getTime() - session.lastActivityAt.getTime() >= 60_000) {
      await this.prisma.authSession.update({
        where: { id: session.id },
        data: { lastActivityAt: now },
      });
    }
    return session;
  }

  private async revokeSession(sessionId: string, reason: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.authSession.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: now, revokeReason: reason },
      }),
      this.prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
  }

  private async audit(
    eventType: string,
    result: string,
    actorId: string | undefined,
    requestId: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.prisma.outboxEvent.create({
      data: { eventType, result, actorId: actorId ?? null, requestId, metadata },
    });
  }
}

export { safeReturnTo };
