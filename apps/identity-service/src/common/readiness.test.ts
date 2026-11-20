import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertDatabaseReady } from './readiness.js';

describe('readiness (AWS-20)', () => {
  it('passes when the database answers', async () => {
    await expect(assertDatabaseReady(() => Promise.resolve([{ '?column?': 1 }]))).resolves.toBe(
      undefined,
    );
  });

  it('answers 503 when the database fails or does not answer in time', async () => {
    await expect(
      assertDatabaseReady(() => Promise.reject(new Error('ECONNREFUSED'))),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      assertDatabaseReady(() => new Promise(() => undefined), 20),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
