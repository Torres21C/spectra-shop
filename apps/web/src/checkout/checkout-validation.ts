import type { GuatemalaDepartment, ShippingDetails } from '@spectra/contracts';

export const GUATEMALA_DEPARTMENTS: readonly GuatemalaDepartment[] = [
  'Alta Verapaz',
  'Baja Verapaz',
  'Chimaltenango',
  'Chiquimula',
  'El Progreso',
  'Escuintla',
  'Guatemala',
  'Huehuetenango',
  'Izabal',
  'Jalapa',
  'Jutiapa',
  'Petén',
  'Quetzaltenango',
  'Quiché',
  'Retalhuleu',
  'Sacatepéquez',
  'San Marcos',
  'Santa Rosa',
  'Sololá',
  'Suchitepéquez',
  'Totonicapán',
  'Zacapa',
];

export type ShippingField = keyof ShippingDetails;
export type ShippingErrors = Partial<Record<ShippingField, string>>;

const PLAIN_TEXT = /^[^<>\p{Cc}]+$/u;

function clean(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Espejo de las reglas del servidor (ERS §2.4) para mostrar errores por campo (A6). */
export function validateShipping(input: Record<ShippingField, string>): {
  readonly errors: ShippingErrors;
  readonly value: ShippingDetails | undefined;
} {
  const recipientName = clean(input.recipientName);
  const phone = input.phone.trim();
  const department = input.department;
  const municipality = clean(input.municipality);
  const address = clean(input.address);
  const references = clean(input.references ?? '');
  const errors: ShippingErrors = {};
  if (
    !/^[\p{L}]+(?: [\p{L}]+)*$/u.test(recipientName) ||
    recipientName.length < 2 ||
    recipientName.length > 80
  ) {
    errors.recipientName = 'Ingresa un nombre válido (2–80 letras).';
  }
  if (!/^\d{4}-?\d{4}$/.test(phone)) {
    errors.phone = 'Ingresa 8 dígitos, por ejemplo 5555-0101.';
  }
  if (!(GUATEMALA_DEPARTMENTS as readonly string[]).includes(department)) {
    errors.department = 'Selecciona un departamento.';
  }
  if (municipality.length < 2 || municipality.length > 60 || !PLAIN_TEXT.test(municipality)) {
    errors.municipality = 'Ingresa un municipio válido (2–60 caracteres).';
  }
  if (address.length < 5 || address.length > 150 || !PLAIN_TEXT.test(address)) {
    errors.address = 'Ingresa una dirección ficticia (5–150 caracteres, sin < ni >).';
  }
  if (references.length > 200 || (references && !PLAIN_TEXT.test(references))) {
    errors.references = 'Máximo 200 caracteres de texto plano.';
  }
  if (Object.keys(errors).length > 0) return { errors, value: undefined };
  const digits = phone.replace('-', '');
  return {
    errors,
    value: {
      recipientName,
      phone: `${digits.slice(0, 4)}-${digits.slice(4)}`,
      department,
      municipality,
      address,
      ...(references ? { references } : {}),
    },
  };
}
