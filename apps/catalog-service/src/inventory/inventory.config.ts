function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

export const inventoryConfig = {
  /** Vigencia de una reserva PENDING; después solo puede liberarse, nunca confirmarse. */
  reservationTtlSeconds: integerEnv('RESERVATION_TTL_SECONDS', 120, 10, 3600),
  /** Intervalo del barrido de reservas vencidas; 0 lo limita al arranque. */
  sweepIntervalMs: integerEnv('RESERVATION_SWEEP_INTERVAL_MS', 10_000, 0, 600_000),
  sweepBatchSize: 50,
  caller: 'commerce-service',
};
