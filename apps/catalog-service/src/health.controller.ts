import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { HealthResponse } from '@spectra/contracts';

@SkipThrottle()
@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return { service: 'catalog-service', status: 'ok' };
  }
}
