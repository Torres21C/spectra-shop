import { describe, expect, it } from 'vitest';
import { validateShipping } from './checkout-validation.js';

const valid = {
  recipientName: '  Ana   Pérez ',
  phone: '55550101',
  department: 'Guatemala',
  municipality: 'Mixco',
  address: 'Calle ficticia 1-23',
  references: '',
};

describe('fictitious shipping validation (RF-021)', () => {
  it('normalizes a valid address and omits empty references', () => {
    expect(validateShipping(valid)).toEqual({
      errors: {},
      value: {
        recipientName: 'Ana Pérez',
        phone: '5555-0101',
        department: 'Guatemala',
        municipality: 'Mixco',
        address: 'Calle ficticia 1-23',
      },
    });
  });

  it('reports every invalid field instead of sending the request', () => {
    const result = validateShipping({
      recipientName: 'Ana 1',
      phone: '5555',
      department: 'Narnia',
      municipality: 'M',
      address: '<b>',
      references: '<script>',
    });
    expect(result.value).toBeUndefined();
    expect(Object.keys(result.errors).sort()).toEqual([
      'address',
      'department',
      'municipality',
      'phone',
      'recipientName',
      'references',
    ]);
  });
});
