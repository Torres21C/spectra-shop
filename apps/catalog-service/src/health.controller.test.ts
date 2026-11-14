import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('identifies the catalog service', () => {
    expect(new HealthController().getHealth()).toEqual({
      service: 'catalog-service',
      status: 'ok',
    });
  });
});
