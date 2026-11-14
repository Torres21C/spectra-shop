import { createHash } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import argon2 from 'argon2';

// SHA-256 sólo permite comparar contra la lista pública local sin almacenar sus literales.
// Las credenciales reales siempre usan Argon2id.
const COMMON_PASSWORD_DIGESTS = new Set([
  '2a33349e7e606a8ad2e30e3c84521f9377450cf09083e162e0a9b1480ce0f972',
  'b9c950640e1b3740e98acb93e669c65766f6670dd1609ba91ff41052ba48c6f3',
  '3a5745a05f87ddee1db68b217dc043bfa206d1c7aaa1dd0a7dd76b852a733597',
  '8e7ab8d9fe3b324acdd1f76735eea350ea61ac24cbd17e5446946e5a4c71d999',
  'b20b0f63ce2ed361e8845d6bf2e59811aaa06ec96bcdb92f9bc0c5a25e83c9a6',
  'f4ec0b49645b04d2cf4d9797bb49cb382c187c71b26b5d2ce4644d3f6681dc84',
]);

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  private dummyHash: string | undefined;

  validateForRegistration(password: string, confirmation: string, email: string): void {
    const commonDigest = createHash('sha256')
      .update(password.toLocaleLowerCase(), 'utf8')
      .digest('hex');
    if (
      password !== confirmation ||
      password.toLocaleLowerCase() === email.toLocaleLowerCase() ||
      COMMON_PASSWORD_DIGESTS.has(commonDigest)
    ) {
      throw new BadRequestException();
    }
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  verify(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }

  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= await this.hash('dummy-password-that-is-never-valid');
    await this.verify(this.dummyHash, password);
  }
}
