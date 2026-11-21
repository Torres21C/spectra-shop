# Secretos de la aplicación en Secrets Manager (plan §9, AWS-19), SIN pasar por el state de Terraform.
#
# Mecanismo (ADR-AWS-05, D-AWS-05-05; verificado con Terraform 1.17.2, hashicorp/aws 6.70.0 y
# hashicorp/random 3.9.1):
#   - `ephemeral "random_password"` genera el valor en memoria en cada ejecución; Terraform no lo guarda en
#     el state ni en el plan.
#   - `secret_string_wo` (write-only) envía el valor a Secrets Manager; tampoco se persiste.
#   - `secret_string_wo_version` (número normal, sí persistido) decide cuándo se reenvía: solo al crear el
#     secreto o al incrementar la versión. Así, los valores generados en ejecuciones posteriores se
#     descartan y el secreto no cambia. Nunca se le pasa un valor efímero (hashicorp/terraform-provider-aws
#     #44590).
#
# Rotar un secreto = incrementar su entrada en `secret_versions` y volver a ejecutar db-provision (las
# contraseñas de rol) o redesplegar los servicios (tokens). Ver README, «Secretos».
#
# Contenido por rol de base de datos: {"username", "password", "url"}. Las tareas leen claves concretas con
# `valueFrom = "<arn>:<clave>::"` y cada rol de ejecución solo puede leer sus propios secretos.

locals {
  # DT-09: roles creados por infra/postgres/provision-service-roles.sql.
  db_roles = {
    for pair in setproduct(["identity", "catalog", "commerce", "audit"], ["migrator", "app"]) :
    "${pair[0]}-${pair[1]}" => {
      schema   = pair[0]
      username = "spectra_${pair[0]}_${pair[1]}"
    }
  }

  url_query = "sslmode=require&connection_limit=${var.connection_limit}"
}

# Hexadecimal en minúsculas de 64 caracteres: el aprovisionamiento exige ^[0-9a-f]{32,128}$ y valores
# distintos. Juego de caracteres = dígitos + «abcdef» (override_special), sin mayúsculas ni minúsculas.
ephemeral "random_password" "db_role" {
  for_each = local.db_roles

  length           = 64
  upper            = false
  lower            = false
  numeric          = true
  special          = true
  override_special = "abcdef"
}

resource "aws_secretsmanager_secret" "db_role" {
  # Nota (CKV2_AWS_57, no evaluado como fallo por Checkov 3.4.6): Rotación manual controlada (versión write-only + db-provision); la rotación automática exigiría una Lambda en la VPC (fuera del alcance del laboratorio).
  for_each = local.db_roles

  name                    = "${var.secret_prefix}/db/${each.key}"
  description             = "DT-09: credencial y URL de ${each.value.username}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_days
}

resource "aws_secretsmanager_secret_version" "db_role" {
  for_each = local.db_roles

  secret_id = aws_secretsmanager_secret.db_role[each.key].id
  secret_string_wo = jsonencode({
    username = each.value.username
    password = ephemeral.random_password.db_role[each.key].result
    url = format(
      "postgresql://%s:%s@%s:%d/%s?schema=%s&%s",
      each.value.username,
      ephemeral.random_password.db_role[each.key].result,
      var.db_address,
      var.db_port,
      var.db_name,
      each.value.schema,
      local.url_query,
    )
  })
  secret_string_wo_version = lookup(var.secret_versions, "db/${each.key}", 1)
}

# Tokens de servicio (64 hex). Dos secretos distintos: Commerce exige que el de inventario difiera del
# compartido (commerce.config.ts).
ephemeral "random_password" "token" {
  for_each = toset(["internal-token", "inventory-token"])

  length           = 64
  upper            = false
  lower            = false
  numeric          = true
  special          = true
  override_special = "abcdef"
}

resource "aws_secretsmanager_secret" "token" {
  # Nota (CKV2_AWS_57, no evaluado como fallo por Checkov 3.4.6): Rotación manual controlada (versión write-only + redespliegue; SPECTRA_INTERNAL_TOKENS admite dos tokens durante el cambio).
  for_each = toset(["internal-token", "inventory-token"])

  name                    = "${var.secret_prefix}/${each.key}"
  description             = "Token de servicio ${each.key}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_days
}

resource "aws_secretsmanager_secret_version" "token" {
  for_each = toset(["internal-token", "inventory-token"])

  secret_id                = aws_secretsmanager_secret.token[each.key].id
  secret_string_wo         = ephemeral.random_password.token[each.key].result
  secret_string_wo_version = lookup(var.secret_versions, each.key, 1)
}

# ADMIN sintético opcional (M06 mínimo): lo consume el seed de identity-migrate, que solo inserta.
ephemeral "random_password" "synthetic_admin" {
  count = var.synthetic_admin_email == null ? 0 : 1

  length      = 32
  special     = false
  min_upper   = 2
  min_lower   = 2
  min_numeric = 2
}

resource "aws_secretsmanager_secret" "synthetic_admin" {
  # Nota (CKV2_AWS_57, no evaluado como fallo por Checkov 3.4.6): Credencial sintética de laboratorio; rotación manual por versión.
  count = var.synthetic_admin_email == null ? 0 : 1

  name                    = "${var.secret_prefix}/synthetic-admin"
  description             = "M06 minimo: ADMIN sintetico del laboratorio"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_days
}

resource "aws_secretsmanager_secret_version" "synthetic_admin" {
  count = var.synthetic_admin_email == null ? 0 : 1

  secret_id = aws_secretsmanager_secret.synthetic_admin[0].id
  secret_string_wo = jsonencode({
    email    = var.synthetic_admin_email
    password = ephemeral.random_password.synthetic_admin[0].result
  })
  secret_string_wo_version = lookup(var.secret_versions, "synthetic-admin", 1)
}
