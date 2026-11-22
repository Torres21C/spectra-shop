# Repositorios ECR (plan §10). Etiquetas inmutables (el SHA del commit; `<sha>-migrate` para la imagen de
# migración de ADR-AWS-03), escaneo al publicar y cifrado KMS. La publicación de imágenes es responsabilidad
# de PR-6. Desde PR-6.2 solo lo usa la raíz infra/terraform/publisher (ADR-AWS-06, D-AWS-06-17).

resource "aws_ecr_repository" "this" {
  for_each = toset(var.repositories)

  name                 = "${var.repository_prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.force_delete

  image_scanning_configuration {
    scan_on_push = true
  }

  # PR-6.2 (D2, ADR-AWS-06 D-AWS-06-19): sin kms_key_arn, ECR cifra con la clave administrada por AWS
  # `aws/ecr` (KMS). El cifrado de un repositorio no se puede cambiar después: pasar a una CMK propia exige
  # recrear el repositorio.
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

# Conserva las últimas N imágenes etiquetadas (cada commit publica runtime y migrate) y expira las
# imágenes sin etiqueta tras 7 días.
resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expira imagenes sin etiqueta"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Conserva las ultimas imagenes etiquetadas"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.keep_images
        }
        action = { type = "expire" }
      },
    ]
  })
}
