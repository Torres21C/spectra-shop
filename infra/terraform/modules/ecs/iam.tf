# IAM de ECS con mínimo privilegio (plan §8, ADR-AWS-05 D-AWS-05-04).
#
# - Un ROL DE EJECUCIÓN por carga de trabajo (10): descarga SU imagen, escribe en SU log group y lee
#   exactamente los secretos que inyecta su task definition (derivados de local.workloads). Un servicio
#   comprometido o una task definition mal escrita no puede leer los secretos de otro.
# - ROL DE TAREA (credenciales dentro del contenedor) solo para identity-service: kms:Sign y
#   kms:GetPublicKey sobre la clave de JWT. Los demás servicios y las tareas de operación no llaman a APIs de
#   AWS, así que no tienen rol de tarea: el contenedor no recibe ninguna credencial.
# - Sin credenciales estáticas, sin ECS Exec y sin permisos administrativos.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Mitigación de «confused deputy».
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${var.region}:${var.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each = toset(keys(local.workloads))

  name               = "${var.name_prefix}-exec-${each.key}"
  description        = "Rol de ejecucion ECS de ${each.key} (imagen, logs y sus secretos)"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "execution" {
  for_each = toset(keys(local.workloads))

  # GetAuthorizationToken no admite permisos a nivel de recurso.
  statement {
    sid       = "EcrAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PullOwnImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [var.repository_arns[local.workloads[each.key].repository]]
  }

  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${var.log_group_arns[each.key]}:*"]
  }

  statement {
    sid       = "ReadOwnSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = distinct([for secret in values(local.workloads[each.key].secrets) : secret.arn])
  }

  statement {
    sid       = "DecryptSecretsViaSecretsManager"
    actions   = ["kms:Decrypt"]
    resources = [var.data_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = toset(keys(local.workloads))

  name   = "least-privilege-execution"
  role   = aws_iam_role.execution[each.key].id
  policy = data.aws_iam_policy_document.execution[each.key].json
}

# ---------------------------------------------------------------------------------------------------------
# Rol de tarea de identity-service: firma de JWT con KMS (ADR-AWS-02).
# ---------------------------------------------------------------------------------------------------------
resource "aws_iam_role" "identity_task" {
  name               = "${var.name_prefix}-task-identity"
  description        = "Rol de tarea de identity-service: firma ES256 con KMS"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "identity_task" {
  statement {
    sid       = "SignJwtEs256Only"
    actions   = ["kms:Sign"]
    resources = [var.jwt_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:SigningAlgorithm"
      values   = ["ECDSA_SHA_256"]
    }

    # D-AWS-02-02: el adaptador firma con MessageType RAW.
    condition {
      test     = "StringEquals"
      variable = "kms:MessageType"
      values   = ["RAW"]
    }
  }

  statement {
    sid       = "ReadJwtPublicKey"
    actions   = ["kms:GetPublicKey"]
    resources = [var.jwt_key_arn]
  }
}

resource "aws_iam_role_policy" "identity_task" {
  name   = "kms-sign-jwt"
  role   = aws_iam_role.identity_task.id
  policy = data.aws_iam_policy_document.identity_task.json
}
