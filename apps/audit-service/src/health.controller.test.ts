import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('identifies the audit service', () => {
    expect(new HealthController().getHealth()).toEqual({ service: 'audit-service', status: 'ok' });
  });
});
