-- DT-09 (M06.0): permisos mínimos del rol de ejecución de Commerce.
-- Lo aplica spectra_commerce_migrator (propietario del esquema) después de `prisma migrate deploy`.
-- Idempotente: revoca todo y vuelve a conceder la matriz explícita. Una migración que añada tablas
-- o necesite nuevas operaciones (p. ej. transiciones administrativas de M06) debe ampliar este archivo.
REVOKE ALL ON ALL TABLES IN SCHEMA "commerce" FROM "spectra_commerce_app";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "commerce" FROM "spectra_commerce_app";

GRANT SELECT, INSERT, UPDATE ON "commerce"."carts" TO "spectra_commerce_app";
-- Quitar una línea del carrito es el único borrado que realiza el servicio.
GRANT SELECT, INSERT, UPDATE, DELETE ON "commerce"."cart_items" TO "spectra_commerce_app";
GRANT SELECT, INSERT, UPDATE ON "commerce"."checkout_attempts" TO "spectra_commerce_app";
-- Los pedidos y sus líneas se crean en C3 y M05 solo los consulta.
GRANT SELECT, INSERT ON "commerce"."orders" TO "spectra_commerce_app";
GRANT SELECT, INSERT ON "commerce"."order_items" TO "spectra_commerce_app";
GRANT SELECT, INSERT ON "commerce"."outbox_events" TO "spectra_commerce_app";
-- Número de pedido (DEFAULT nextval).
GRANT USAGE ON SEQUENCE "commerce"."order_number_seq" TO "spectra_commerce_app";
