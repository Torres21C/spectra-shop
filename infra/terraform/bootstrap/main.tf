# Bootstrap del estado remoto de Terraform (ADR-AWS-05 D-AWS-05-11). Se aplica UNA vez, por separado y con
# autorización, antes del entorno lab. Su propio state es local y pequeño (no contiene secretos): guárdelo
# fuera del repositorio o mígrelo al bucket creado (README, «Estado remoto»).
#
# Controles: bucket privado (Block Public Access y BucketOwnerEnforced), versionado, SSE-KMS con clave propia
# y rotación, solo TLS, bloqueo nativo de S3 (`use_lockfile`) y protección contra destrucción accidental.

data "aws_caller_identity" "current" {}

locals {
  bucket_name = "spectra-tfstate-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
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
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
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
  # Nota (CKV_AWS_144, no evaluado como fallo por Checkov 3.4.6): Replicación entre regiones innecesaria para el laboratorio; el versionado protege frente a borrados.
  # Nota (CKV2_AWS_62, no evaluado como fallo por Checkov 3.4.6): Sin notificaciones de eventos: no hay consumidores.
  # Nota (CKV_AWS_18, no evaluado como fallo por Checkov 3.4.6): Registro de accesos del bucket opcional; CloudTrail registra las llamadas de gestión.
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

    content {
      sid       = "DenyOtherPrincipals"
      effect    = "Deny"
      actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
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
