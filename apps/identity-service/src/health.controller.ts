import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { HealthResponse } from '@spectra/contracts';
import { assertDatabaseReady } from './common/readiness.js';
import { PrismaService } from './database/prisma.service.js';

// Los health checks del balanceador no consumen el límite por IP.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Vida del proceso (estático). */
  @Get()
  getHealth(): HealthResponse {
    return { service: 'identity-service', status: 'ok' };
  }

  /** AWS-20: preparación para recibir tráfico (PostgreSQL propio accesible). */
  @Get('ready')
  async getReadiness(): Promise<{ service: string; status: 'ready' }> {
    await assertDatabaseReady(() => this.prisma.$queryRaw`SELECT 1`);
    return { service: 'identity-service', status: 'ready' };
  }
}
