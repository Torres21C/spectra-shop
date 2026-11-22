# Auditoría de los accesos al state de Terraform (PR-6.2, R-PR5-26; ADR-AWS-05 D-AWS-05-18 a D-AWS-05-20).
#
# Un trail de CloudTrail registra los EVENTOS DE DATOS de S3 (lectura y escritura de objetos: GetObject,
# PutObject, DeleteObject, HeadObject…) SOLO del bucket del state, con la identidad IAM de cada acceso. Los
# registros se guardan en un bucket propio, cifrados con la CMK del state (D5) y con validación de integridad.
#
# - Alcance: selector avanzado con resources.ARN que empieza por "arn:aws:s3:::<bucket-del-state>/". El bucket
#   de auditoría queda FUERA a propósito: registrar sus objetos haría que el trail registrara sus propias
#   entregas una y otra vez.
# - Sin eventos de gestión (el historial de eventos de CloudTrail ya los conserva 90 días sin costo) y de una
#   sola región: el bucket del state está en var.aws_region y los eventos de datos son regionales.
# - Retención de 365 días (D8) y controles contra el borrado: versionado, denegación de DeleteObjectVersion a
#   todos los principales y validación de integridad (archivos de resumen firmados). NO es almacenamiento WORM:
#   un administrador con permisos de IAM puede cambiar la política del bucket o detener el trail; quedaría
#   registrado en el historial de eventos de gestión. Object Lock no se usa (decisión D8).
# - Sin dependencias circulares: el state del bootstrap es local (no se guarda en el bucket que se audita) y
#   el ARN del trail se construye como texto en main.tf (local.audit_trail_arn).

locals {
  audit_bucket_name = "spectra-tfstate-audit-${local.account_id}-${var.aws_region}"
}

resource "aws_s3_bucket" "audit" {
  # checkov:skip=CKV_AWS_18:Bucket de registros de auditoría (PR-6.2): registrar sus propios accesos exigiría otro bucket de registros, y así sucesivamente. Lo protegen la política (solo este trail escribe y nadie borra versiones), Block Public Access, el versionado y el historial de eventos de gestión de CloudTrail.
  # checkov:skip=CKV_AWS_144:Replicación entre regiones innecesaria para el laboratorio: los registros son evidencia de acceso al state, no datos de negocio; el versionado y la denegación de DeleteObjectVersion protegen frente a borrados.
  # checkov:skip=CKV2_AWS_62:Sin notificaciones de eventos: no hay consumidores de los registros en tiempo real (se consultan bajo demanda como evidencia).
  bucket = local.audit_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket = aws_s3_bucket.audit.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

# 365 días tanto para la versión actual como para las anteriores: un borrado (marcador) no acorta la
# retención, porque la versión anterior se conserva el mismo plazo y nadie puede borrarla antes (política).
resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    id     = "retain-state-audit-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.audit_log_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.audit_log_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit]
}

data "aws_iam_policy_document" "audit_bucket" {
  # Entrega de CloudTrail (plantilla documentada por AWS), limitada a este trail con aws:SourceArn.
  statement {
    sid       = "AllowStateAuditTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.audit.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }
  }

  statement {
    sid       = "AllowStateAuditTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/AWSLogs/${local.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.audit.arn,
      "${aws_s3_bucket.audit.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Nadie borra versiones de los registros: solo las expira el ciclo de vida (lo ejecuta S3, no un principal).
  statement {
    sid       = "DenyAuditLogVersionDeletion"
    effect    = "Deny"
    actions   = ["s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.audit.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "audit" {
  bucket = aws_s3_bucket.audit.id
  policy = data.aws_iam_policy_document.audit_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.audit]
}

resource "aws_cloudtrail" "state_audit" {
  # checkov:skip=CKV_AWS_67:Trail de alcance limitado a propósito (R-PR5-26): solo registra los eventos de datos del bucket del state, que está en us-east-1, y los eventos de datos son regionales. No sustituye a un trail de cuenta multirregión (fuera del alcance del laboratorio).
  # checkov:skip=CKV_AWS_252:Sin tema SNS de entrega: no hay consumidores de las notificaciones de cada archivo de registro; los registros se consultan bajo demanda como evidencia.
  # checkov:skip=CKV2_AWS_10:Sin integración con CloudWatch Logs por costo y alcance del laboratorio: los registros quedan en S3 con validación de integridad (archivos de resumen). Sin alarmas en tiempo real sobre los accesos al state (riesgo residual documentado).
  name                          = local.audit_trail_name
  s3_bucket_name                = aws_s3_bucket.audit.id
  kms_key_id                    = aws_kms_key.state.arn
  enable_log_file_validation    = true
  enable_logging                = true
  include_global_service_events = false
  is_multi_region_trail         = false

  # Solo eventos de datos de objetos del bucket del state (lectura y escritura). Sin eventos de gestión.
  advanced_event_selector {
    name = "Objetos del state de Terraform (lectura y escritura)"

    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }

    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }

    field_selector {
      field       = "resources.ARN"
      starts_with = ["${aws_s3_bucket.state.arn}/"]
    }
  }

  # CloudTrail comprueba al crear el trail que puede escribir en el bucket y cifrar con la clave.
  depends_on = [aws_s3_bucket_policy.audit, aws_kms_key.state]
}
