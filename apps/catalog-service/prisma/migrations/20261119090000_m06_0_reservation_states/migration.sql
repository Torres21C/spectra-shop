-- DT-08 (M06.0): estados internos de reconocimiento de entrega y reposición.
-- Va en una migración propia: PostgreSQL no permite usar un valor de enum añadido dentro de la misma
-- transacción, y la restricción de estados de la migración siguiente los referencia.
ALTER TYPE "catalog"."ReservationStatus" ADD VALUE IF NOT EXISTS 'FULFILLED';
ALTER TYPE "catalog"."ReservationStatus" ADD VALUE IF NOT EXISTS 'RESTOCKED';
