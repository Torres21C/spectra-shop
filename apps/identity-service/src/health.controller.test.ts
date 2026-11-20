import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { PrismaService } from './database/prisma.service.js';
import { HealthController } from './health.controller.js';

function controller(queryRaw: () => Promise<unknown>): HealthController {
  return new HealthController({ $queryRaw: queryRaw } as unknown as PrismaService);
}

describe('HealthController', () => {
  it('identifies the identity service', () => {
    expect(controller(() => Promise.resolve([])).getHealth()).toEqual({
      service: 'identity-service',
      status: 'ok',
    });
  });

  it('reports readiness only when PostgreSQL answers (AWS-20)', async () => {
    await expect(controller(() => Promise.resolve([{ ok: 1 }])).getReadiness()).resolves.toEqual({
      service: 'identity-service',
      status: 'ready',
    });
    await expect(
      controller(() => Promise.reject(new Error('down'))).getReadiness(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
