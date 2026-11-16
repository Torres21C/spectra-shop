import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import type { GuatemalaDepartment, SimulatedPaymentResult } from '@spectra/contracts';
import { GUATEMALA_DEPARTMENTS, normalizePhone, normalizeText } from './checkout.helpers.js';

// Texto plano: sin caracteres de control ni marcas HTML (RS09; los datos son ficticios, RN-18).
const PLAIN_TEXT = /^[^<>\p{Cc}]+$/u;
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizeText(value) : value;

/**
 * POST /orders (contrato ERS conservado, D-M04-07). Sin campos de tarjeta (RN-14, CA-M04-05) ni
 * importes: `price`, `total`, `userId`, `cardNumber`, `cvv`… se rechazan con 400 por lista blanca.
 */
export class PlaceOrderDto {
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  @Matches(/^[\p{L}]+(?: [\p{L}]+)*$/u, { message: 'Nombre inválido' })
  recipientName!: string;

  @IsString()
  @Matches(/^\d{4}-?\d{4}$/)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d{4}-?\d{4}$/.test(value) ? normalizePhone(value) : value,
  )
  phone!: string;

  @IsIn(GUATEMALA_DEPARTMENTS)
  department!: GuatemalaDepartment;

  @Transform(trim)
  @IsString()
  @Length(2, 60)
  @Matches(PLAIN_TEXT)
  municipality!: string;

  @Transform(trim)
  @IsString()
  @Length(5, 150)
  @Matches(PLAIN_TEXT)
  address!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  @Matches(PLAIN_TEXT)
  references?: string;

  @IsIn(['APROBADO', 'RECHAZADO'])
  simulatedPaymentResult!: SimulatedPaymentResult;

  @Matches(/^[a-f0-9]{64}$/)
  cartFingerprint!: string;
}

export class OrderIdDto {
  @IsUUID('4')
  orderId!: string;
}
