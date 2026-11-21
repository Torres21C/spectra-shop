# Rol publicador de imágenes en ECR para GitHub Actions mediante OIDC (PR-6, ADR-AWS-06).
#
# - Solo lo puede asumir un job del repositorio autorizado que use el GitHub Environment indicado: el claim
#   sub se compara con StringEquals (sin comodines) en el formato inmutable repo:OWNER@ID/REPO@ID, y aud debe
#   ser sts.amazonaws.com.
# - Permisos: únicamente publicar en los repositorios ECR del módulo registry. Sin KMS (ECR cifra con su
#   propia concesión sobre la CMK), sin ECS, IAM, Secrets Manager, S3 ni Terraform. El despliegue ECS será
#   un rol distinto (fuera de PR-6).
# - Desactivado por defecto (enabled = false): no se crea nada hasta que el propietario lo autorice.

locals {
  oidc_provider_arn = var.enabled ? (var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_oidc_provider_arn) : null
  oidc_subject      = "${var.oidc_subject_prefix}:environment:${var.github_environment}"

  publish_actions = [
    "ecr:BatchCheckLayerAvailability",
    "ecr:BatchGetImage",
    "ecr:CompleteLayerUpload",
    "ecr:DescribeImages",
    "ecr:InitiateLayerUpload",
    "ecr:PutImage",
    "ecr:UploadLayerPart",
  ]

  trust_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubActionsEcrPublishEnvironmentOnly"
      Effect    = "Allow"
      Principal = { Federated = local.oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = local.oidc_subject
        }
      }
    }]
  })

  publish_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # GetAuthorizationToken no admite restricción por recurso (lo exige el inicio de sesión en el registro).
        Sid      = "EcrAuthorizationToken"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        # Política de publicación documentada por AWS (image-push-iam) más DescribeImages, que el workflow usa
        # para detectar etiquetas inmutables ya existentes y verificar el digest publicado.
        Sid      = "PublishToSpectraRepositories"
        Effect   = "Allow"
        Action   = local.publish_actions
        Resource = sort(values(var.repository_arns))
      },
    ]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.enabled && var.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # Sin thumbprint_list: AWS valida el certificado de GitHub con sus CA de confianza.
}

resource "aws_iam_role" "publisher" {
  count = var.enabled ? 1 : 0

  name                 = "${var.name_prefix}-ecr-publisher"
  description          = "GitHub Actions (OIDC, Environment ${var.github_environment}): publicacion en ECR. Sin despliegue."
  assume_role_policy   = local.trust_policy
  max_session_duration = 3600
  permissions_boundary = var.permissions_boundary_arn

  lifecycle {
    precondition {
      condition     = var.create_oidc_provider || var.existing_oidc_provider_arn != null
      error_message = "Con create_oidc_provider = false hay que indicar existing_oidc_provider_arn (no se duplica el proveedor de la cuenta)."
    }
  }
}

resource "aws_iam_role_policy" "publish" {
  count = var.enabled ? 1 : 0

  name   = "ecr-publish-only"
  role   = aws_iam_role.publisher[0].id
  policy = local.publish_policy
}
