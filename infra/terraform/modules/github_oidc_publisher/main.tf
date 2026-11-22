# Rol publicador de imágenes en ECR para GitHub Actions mediante OIDC (PR-6, ADR-AWS-06).
#
# - Solo lo puede asumir un job del repositorio autorizado que use el GitHub Environment indicado: el claim
#   sub se compara con StringEquals (sin comodines) en el formato inmutable repo:OWNER@ID/REPO@ID, y aud debe
#   ser sts.amazonaws.com.
# - Permisos: únicamente publicar en los repositorios ECR del módulo registry. Sin KMS (ECR cifra con su
#   propia concesión sobre la CMK), sin ECS, IAM, Secrets Manager, S3 ni Terraform. El despliegue ECS será
#   un rol distinto (fuera de PR-6).
# - Desactivado por defecto (enabled = false): no se crea nada hasta que el propietario lo autorice.
# - Proveedor OIDC (PR-6.2, D3): AWS admite uno solo por URL y cuenta. Si ya existe, no se importa ni se
#   duplica: se lee por su URL y se exige que acepte la audiencia sts.amazonaws.com.
# - Desde PR-6.2 solo lo usa la raíz infra/terraform/publisher (ADR-AWS-06, D-AWS-06-17).

locals {
  github_oidc_url   = "https://token.actions.githubusercontent.com"
  reuse_provider    = var.enabled && !var.create_oidc_provider
  oidc_provider_arn = var.enabled ? (var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.existing[0].arn) : null
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

  url            = local.github_oidc_url
  client_id_list = ["sts.amazonaws.com"]
  # Sin thumbprint_list: AWS valida el certificado de GitHub con sus CA de confianza.
}

# Proveedor ya existente en la cuenta (create_oidc_provider = false): solo lectura, nunca se administra aquí.
data "aws_iam_openid_connect_provider" "existing" {
  count = local.reuse_provider ? 1 : 0

  url = local.github_oidc_url

  lifecycle {
    postcondition {
      condition     = contains(self.client_id_list, "sts.amazonaws.com")
      error_message = "El proveedor OIDC de GitHub existente no acepta la audiencia sts.amazonaws.com: no se crea el rol."
    }
  }
}

resource "aws_iam_role" "publisher" {
  count = var.enabled ? 1 : 0

  name                 = "${var.name_prefix}-ecr-publisher"
  description          = "GitHub Actions (OIDC, Environment ${var.github_environment}): publicacion en ECR. Sin despliegue."
  assume_role_policy   = local.trust_policy
  max_session_duration = 3600
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy" "publish" {
  count = var.enabled ? 1 : 0

  name   = "ecr-publish-only"
  role   = aws_iam_role.publisher[0].id
  policy = local.publish_policy
}
