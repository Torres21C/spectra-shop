# RDS for PostgreSQL privado (AD-06, ADR-AWS-01).
#
# - Single-AZ, sin IP pública, en las subredes de datos, cifrado con la CMK de datos.
# - Contraseña del maestro gestionada por RDS en Secrets Manager (manage_master_user_password): nunca pasa
#   por Terraform ni por su state.
# - El maestro (rds_superuser, CREATEROLE, CREATEDB, propietario de la base) solo lo usan las tareas
#   db-provision y db-finalize (modo «administrador delegado» de provision-service-roles.sql).
# - Parameter group con los requisitos de ADR-AWS-01: TLS obligatorio y servidor sin registro de sentencias.

locals {
  engine_major = split(".", var.engine_version)[0]
  # Log group que RDS usa al exportar logs; se crea antes para fijar cifrado KMS y retención.
  postgresql_log_group = "/aws/rds/instance/${var.identifier}/postgresql"
  upgrade_log_group    = "/aws/rds/instance/${var.identifier}/upgrade"
}

resource "aws_db_subnet_group" "this" {
  name        = "${var.identifier}-subnets"
  description = "Subredes privadas de datos de ${var.identifier}"
  subnet_ids  = var.subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name        = "${var.identifier}-pg${local.engine_major}"
  family      = "postgres${local.engine_major}"
  description = "SPECTRA lab: TLS obligatorio y sin registro de sentencias (ADR-AWS-01)"

  # C6 (desviación de laboratorio): el servidor exige TLS; los clientes usan sslmode=require (cifrado sin
  # verificación del certificado). No equivale a verify-full (ADR-AWS-05, D-AWS-05-07).
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  # ADR-AWS-01: ALTER ROLE transporta contraseñas; el script de aprovisionamiento aborta si el servidor
  # registra sentencias.
  parameter {
    name         = "log_statement"
    value        = "none"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "log_min_duration_statement"
    value        = "-1"
    apply_method = "pending-reboot"
  }

  # Mitiga el riesgo residual de ADR-AWS-01: con el valor por defecto («error»), el texto de un ALTER ROLE
  # fallido (con la contraseña) quedaría en el log de RDS y en CloudWatch. Con «panic» el servidor registra
  # el error pero no la sentencia (ADR-AWS-05, D-AWS-05-08).
  parameter {
    name         = "log_min_error_statement"
    value        = "panic"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "log_connections"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "log_disconnections"
    value        = "1"
    apply_method = "pending-reboot"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "postgresql" {
  # checkov:skip=CKV_AWS_338:Retención de 30 días en el laboratorio (plan §5, paso 8; costo). Exportar a la bóveda las evidencias necesarias antes de que expiren.
  name              = local.postgresql_log_group
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_cloudwatch_log_group" "upgrade" {
  # checkov:skip=CKV_AWS_338:Retención de 30 días en el laboratorio (plan §5, paso 8; costo). Exportar a la bóveda las evidencias necesarias antes de que expiren.
  name              = local.upgrade_log_group
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_db_instance" "this" {
  # checkov:skip=CKV_AWS_157:AD-06 laboratorio Single-AZ (Multi-AZ en producción, AWS-28).
  # checkov:skip=CKV_AWS_161:DT-09 usa roles PostgreSQL con contraseña por servicio; la autenticación IAM no está implementada en los servicios.
  # checkov:skip=CKV_AWS_118:Enhanced Monitoring desactivado por costo en el laboratorio; métricas básicas y alarmas en CloudWatch.
  # checkov:skip=CKV_AWS_353:Performance Insights desactivado por costo en el laboratorio.
  # Nota (CKV_AWS_354, no evaluado como fallo por Checkov 3.4.6): Performance Insights desactivado (no hay datos que cifrar).
  # Nota (CKV2_AWS_30, no evaluado como fallo por Checkov 3.4.6): El registro de sentencias está deshabilitado a propósito (ADR-AWS-01: ALTER ROLE transporta contraseñas).
  identifier = var.identifier

  engine                     = "postgres"
  engine_version             = var.engine_version
  auto_minor_version_upgrade = true
  instance_class             = var.instance_class

  db_name                       = var.db_name
  username                      = var.master_username
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn
  port                          = 5432

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.rds_sg_id]
  publicly_accessible    = false
  multi_az               = false
  network_type           = "IPV4"
  ca_cert_identifier     = var.ca_cert_identifier

  parameter_group_name = aws_db_parameter_group.this.name

  iam_database_authentication_enabled = false

  backup_retention_period  = var.backup_retention_days
  backup_window            = "06:00-07:00"
  maintenance_window       = "sun:07:30-sun:08:30"
  copy_tags_to_snapshot    = true
  delete_automated_backups = true

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : var.final_snapshot_identifier

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  monitoring_interval             = 0
  performance_insights_enabled    = false

  apply_immediately = var.apply_immediately

  depends_on = [
    aws_cloudwatch_log_group.postgresql,
    aws_cloudwatch_log_group.upgrade,
  ]
}
