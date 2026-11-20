import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { trustProxySetting } from './trust-proxy.js';

function ipSeenBehind(setting: number | string | false, forwardedFor: string): Promise<string> {
  const app = express();
  app.set('trust proxy', setting);
  app.get('/', (req, res) => {
    res.json({ ip: req.ip });
  });
  return request(app)
    .get('/')
    .set('X-Forwarded-For', forwardedFor)
    .then((response) => (response.body as { ip: string }).ip);
}

describe('TRUST_PROXY (AWS-11)', () => {
  it('parses the accepted forms and rejects trusting every proxy', () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('2')).toBe(2);
    expect(trustProxySetting('10.20.0.0/16, 127.0.0.1')).toBe('10.20.0.0/16,127.0.0.1');
    for (const invalid of ['true', '0', '11', '10.20.0.0/33', 'proxy.local', '10.0.0.0/8/1']) {
      expect(() => trustProxySetting(invalid), invalid).toThrow('TRUST_PROXY');
    }
  });

  it('ignores X-Forwarded-For by default, so a client cannot spoof its IP', async () => {
    const ip = await ipSeenBehind(false, '203.0.113.7');
    expect(ip).not.toBe('203.0.113.7');
  });

  it('resolves the viewer IP behind CloudFront + ALB and ignores spoofed entries', async () => {
    // CloudFront añade la IP del visitante; el ALB, la del origen VPC de CloudFront. Un cliente puede
    // anteponer valores falsos, que quedan a la izquierda y no se tienen en cuenta.
    const chain = '198.51.100.66, 203.0.113.7, 10.20.1.15';
    await expect(ipSeenBehind(2, chain)).resolves.toBe('203.0.113.7');
    await expect(ipSeenBehind('loopback,10.20.0.0/16', chain)).resolves.toBe('203.0.113.7');
  });
});
