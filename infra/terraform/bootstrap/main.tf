# Bootstrap del estado remoto de Terraform (ADR-AWS-05 D-AWS-05-11). Se aplica UNA vez, por separado y con
# autorización, antes de infra/terraform/publisher y de environments/lab. Su propio state es local y pequeño
# (no contiene secretos): guárdelo fuera del repositorio o mígrelo al bucket creado (README, «Estado remoto»).
#
# Controles: bucket privado (Block Public Access y BucketOwnerEnforced), versionado, SSE-KMS con clave propia
# y rotación, solo TLS, bloqueo nativo de S3 (`use_lockfile`) y protección contra destrucción accidental.
# PR-6.2: auditoría de los accesos al state con CloudTrail (audit.tf, R-PR5-26) y presupuesto de la cuenta
# antes del primer recurso facturable (budget.tf, D7).

data "aws_caller_identity" "current" {}

locals {
  account_id  = data.aws_caller_identity.current.account_id
  bucket_name = "spectra-tfstate-${local.account_id}-${var.aws_region}"

  # El ARN del trail se construye como texto (no como referencia a aws_cloudtrail.state_audit): la política
  # de la clave y la del bucket de auditoría lo necesitan ANTES de que exista el trail, y una referencia
  # crearía un ciclo clave → trail → clave.
  audit_trail_name = "spectra-tfstate-audit"
  audit_trail_arn  = "arn:aws:cloudtrail:${var.aws_region}:${local.account_id}:trail/${local.audit_trail_name}"
}

data "aws_iam_policy_document" "state_key" {
  # checkov:skip=CKV_AWS_109:Política de clave: «*» en resources significa «esta clave»; la raíz delega en IAM.
  # checkov:skip=CKV_AWS_111:Política de clave: «*» en resources significa «esta clave»; la raíz delega en IAM.
  # checkov:skip=CKV_AWS_356:Política de clave: «*» en resources significa «esta clave».
  statement {
    sid       = "EnableIamPolicies"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  # PR-6.2 (D5): CloudTrail cifra con esta clave los registros de acceso al state. Solo el trail de auditoría
  # del state (aws:SourceArn) y solo con su contexto de cifrado; sin Decrypt (lo leen principales de IAM).
  statement {
    sid       = "AllowStateAuditTrailToEncryptLogs"
    actions   = ["kms:GenerateDataKey*"]
    resources = ["*"]

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
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = [local.audit_trail_arn]
    }
  }

  statement {
    sid       = "AllowStateAuditTrailToDescribeKey"
    actions   = ["kms:DescribeKey"]
    resources = ["*"]

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
}

resource "aws_kms_key" "state" {
  description             = "Cifrado del state de Terraform de SPECTRA Shop"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.state_key.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "state" {
  name          = "alias/spectra-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

resource "aws_s3_bucket" "state" {
  # checkov:skip=CKV_AWS_144:Replicación entre regiones innecesaria para el laboratorio; el versionado protege frente a borrados.
  # checkov:skip=CKV2_AWS_62:Sin notificaciones de eventos: no hay consumidores.
  # checkov:skip=CKV_AWS_18:Sin server access logging (D6, PR-6.2). Los accesos a los objetos del state los audita el trail spectra-tfstate-audit con eventos de datos de CloudTrail (audit.tf, R-PR5-26). No son controles idénticos: CloudTrail registra la identidad IAM y la API, con entrega garantizada y validación de integridad, pero no reproduce el formato ni todos los campos del registro de accesos de S3.
  bucket = local.bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
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

  statement {
    sid       = "DenyUnencryptedObjectUploads"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  dynamic "statement" {
    for_each = length(var.state_admin_role_arns) > 0 ? [1] : []

    # Incluye las versiones: el bucket está versionado y S3 autoriza con acciones distintas leer o borrar una
    # versión concreta (s3:GetObjectVersion, s3:DeleteObjectVersion). El ciclo de vida no se ve afectado.
    content {
      sid    = "DenyOtherPrincipals"
      effect = "Deny"
      actions = [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
      ]
      resources = ["${aws_s3_bucket.state.arn}/*"]

      principals {
        type        = "*"
        identifiers = ["*"]
      }

      condition {
        test     = "ArnNotLike"
        variable = "aws:PrincipalArn"
        values   = var.state_admin_role_arns
      }
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}
