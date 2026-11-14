import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@spectra/contracts';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return { service: 'audit-service', status: 'ok' };
  }
}
