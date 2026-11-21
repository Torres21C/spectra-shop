# Claves KMS del laboratorio (plan §3):
#   - data: CMK simétrica para RDS, secretos (incluido el del maestro gestionado por RDS), ECR, CloudWatch
#     Logs y SNS. Rotación anual.
#   - jwt: clave asimétrica ECC_NIST_P256 / SIGN_VERIFY para firmar los JWT de acceso (AD-08,
#     ADR-AWS-02). La clave privada nunca sale de KMS. KMS no rota claves asimétricas: la rotación es
#     manual (ADR-AWS-02, «Rotación»).
#
# Las políticas de clave delegan en IAM (principal raíz de la cuenta) y añaden solo los principales de
# servicio que no usan IAM: CloudWatch Logs (log groups cifrados) y CloudWatch (alarmas → SNS cifrado).

data "aws_iam_policy_document" "data_key" {
  # checkov:skip=CKV_AWS_109:Política de clave: «*» en resources significa «esta clave»; la raíz delega en IAM.
  # checkov:skip=CKV_AWS_111:Política de clave: «*» en resources significa «esta clave»; la raíz delega en IAM.
  # checkov:skip=CKV_AWS_356:Política de clave: «*» en resources significa «esta clave».
  statement {
    sid       = "EnableIamPolicies"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  statement {
    sid = "AllowCloudWatchLogsForThisAccount"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${var.account_id}:log-group:*"]
    }
  }

  statement {
    sid       = "AllowCloudWatchAlarmsToEncryptedSns"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "${var.name_prefix}: RDS, Secrets Manager, ECR, CloudWatch Logs y SNS"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = var.deletion_window_days
  policy                  = data.aws_iam_policy_document.data_key.json
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name_prefix}-data"
  target_key_id = aws_kms_key.data.key_id
}

data "aws_iam_policy_document" "jwt_key" {
  # checkov:skip=CKV_AWS_109:Política de clave: «*» en resources significa «esta clave»; la raíz delega en IAM.
  # checkov:skip=CKV_AWS_111:Política de clave: «*» en resources significa «esta clave»; la raíz delega en IAM.
  # checkov:skip=CKV_AWS_356:Política de clave: «*» en resources significa «esta clave».
  statement {
    sid       = "EnableIamPolicies"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "jwt" {
  # Nota (CKV_AWS_7, no evaluado como fallo por Checkov 3.4.6): KMS no admite rotación automática de claves asimétricas; rotación manual (ADR-AWS-02).
  description              = "${var.name_prefix}: firma ES256 de los JWT de acceso (AD-08)"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = var.deletion_window_days
  policy                   = data.aws_iam_policy_document.jwt_key.json
}

resource "aws_kms_alias" "jwt" {
  name          = "alias/${var.name_prefix}-jwt"
  target_key_id = aws_kms_key.jwt.key_id
}

# Clave pública (no es secreta) para IDENTITY_PUBLIC_KEY_PEM de Catalog, Commerce y Audit (ADR-AWS-02,
# D-AWS-02-04). Evita el paso manual `aws kms get-public-key | openssl`.
data "aws_kms_public_key" "jwt" {
  key_id = aws_kms_key.jwt.arn
}
