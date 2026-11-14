import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('identifies the identity service', () => {
    expect(new HealthController().getHealth()).toEqual({
      service: 'identity-service',
      status: 'ok',
    });
  });
});
