# Rol OIDC publicador de ECR (PR-6, ADR-AWS-06; desde PR-6.2 en la raíz publisher). Proveedor AWS SIMULADO y
# solo `command = plan`: no se contacta con AWS. Comprueba la política de confianza (aud y sub exactos), el
# mínimo privilegio, que el módulo no crea nada mientras esté desactivado y, con un proveedor OIDC ya
# existente (D3), que se lee por URL, no se duplica y se rechaza si no acepta la audiencia sts.amazonaws.com.

mock_provider "aws" {
  mock_resource "aws_iam_openid_connect_provider" {
    override_during = plan
    defaults = {
      arn = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  # Proveedor OIDC ya existente en la cuenta (D3): se lee por URL, nunca se importa.
  mock_data "aws_iam_openid_connect_provider" {
    defaults = {
      arn            = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      url            = "token.actions.githubusercontent.com"
      client_id_list = ["sts.amazonaws.com"]
    }
  }

  mock_resource "aws_iam_role" {
    override_during = plan
    defaults = {
      arn = "arn:aws:iam::111122223333:role/spectra-lab-ecr-publisher"
      id  = "spectra-lab-ecr-publisher"
    }
  }
}

variables {
  name_prefix         = "spectra-lab"
  oidc_subject_prefix = "repo:Torres21C@84191196/spectra-shop@1457499804"
  github_environment  = "ecr-publish-lab"
  repository_arns = {
    for r in ["identity-service", "catalog-service", "commerce-service", "audit-service", "db-ops"] :
    r => "arn:aws:ecr:us-east-1:111122223333:repository/spectra/${r}"
  }
}

run "publisher_disabled_by_default" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  assert {
    condition     = length(aws_iam_role.publisher) == 0 && length(aws_iam_openid_connect_provider.github) == 0 && length(aws_iam_role_policy.publish) == 0
    error_message = "Desactivado por defecto: no debe crear proveedor, rol ni política."
  }

  assert {
    condition     = output.role_arn == null
    error_message = "Sin rol, la salida debe ser null."
  }
}

run "publisher_trust_is_exact" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  variables {
    enabled = true
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 1 && aws_iam_openid_connect_provider.github[0].url == "https://token.actions.githubusercontent.com" && aws_iam_openid_connect_provider.github[0].client_id_list == toset(["sts.amazonaws.com"])
    error_message = "El proveedor OIDC debe ser el de GitHub y aceptar solo la audiencia sts.amazonaws.com."
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.publisher[0].assume_role_policy).Statement) == 1
    error_message = "La política de confianza debe tener una sola sentencia."
  }

  assert {
    condition     = jsondecode(aws_iam_role.publisher[0].assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity" && jsondecode(aws_iam_role.publisher[0].assume_role_policy).Statement[0].Effect == "Allow"
    error_message = "Solo AssumeRoleWithWebIdentity."
  }

  assert {
    condition     = jsondecode(aws_iam_role.publisher[0].assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
    error_message = "El principal debe ser el proveedor OIDC de GitHub."
  }

  assert {
    condition     = keys(jsondecode(aws_iam_role.publisher[0].assume_role_policy).Statement[0].Condition) == ["StringEquals"]
    error_message = "Solo StringEquals: nada de StringLike ni comodines."
  }

  assert {
    condition = jsondecode(aws_iam_role.publisher[0].assume_role_policy).Statement[0].Condition.StringEquals == {
      "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
      "token.actions.githubusercontent.com:sub" = "repo:Torres21C@84191196/spectra-shop@1457499804:environment:ecr-publish-lab"
    }
    error_message = "aud y sub deben coincidir exactamente con sts.amazonaws.com y con el Environment ecr-publish-lab del repositorio."
  }

  assert {
    condition     = !strcontains(aws_iam_role.publisher[0].assume_role_policy, "*")
    error_message = "La política de confianza no puede contener comodines."
  }

  assert {
    condition     = aws_iam_role.publisher[0].max_session_duration == 3600
    error_message = "Sesión máxima de 1 hora."
  }
}

run "publisher_permissions_are_minimal" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  variables {
    enabled = true
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.publish[0].policy).Statement) == 2
    error_message = "Dos sentencias: token de autorización y publicación."
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.publish[0].policy).Statement[0].Action == "ecr:GetAuthorizationToken" && jsondecode(aws_iam_role_policy.publish[0].policy).Statement[0].Resource == "*"
    error_message = "El único permiso sobre * es ecr:GetAuthorizationToken (no admite recurso)."
  }

  assert {
    condition = toset(jsondecode(aws_iam_role_policy.publish[0].policy).Statement[1].Action) == toset([
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages",
      "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
    ])
    error_message = "Solo las acciones de publicación documentadas por AWS más DescribeImages."
  }

  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.publish[0].policy).Statement[1].Resource) == toset(values(var.repository_arns))
    error_message = "La publicación se limita a los 5 repositorios del módulo registry."
  }

  assert {
    condition     = length(regexall("\"(iam|ecs|kms|secretsmanager|s3|sts|cloudformation|logs):|ecr:\\*|\"\\*:|Delete|SetRepositoryPolicy|PutImageTagMutability|PutLifecyclePolicy", aws_iam_role_policy.publish[0].policy)) == 0
    error_message = "Sin permisos de IAM, ECS, KMS, Secrets Manager, S3, STS, CloudFormation ni de administración de ECR."
  }
}

run "publisher_reuses_existing_provider" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  variables {
    enabled              = true
    create_oidc_provider = false
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0 && length(data.aws_iam_openid_connect_provider.existing) == 1
    error_message = "D3: con un proveedor existente no se crea otro; se lee el de la cuenta."
  }

  assert {
    condition     = data.aws_iam_openid_connect_provider.existing[0].url == "https://token.actions.githubusercontent.com"
    error_message = "D3: el proveedor existente se busca por la URL de GitHub Actions."
  }

  assert {
    condition     = jsondecode(aws_iam_role.publisher[0].assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
    error_message = "Debe confiar en el proveedor existente leído por URL."
  }

  assert {
    condition     = output.oidc_provider_managed == false
    error_message = "El proveedor existente no lo administra este módulo."
  }
}

run "publisher_rejects_existing_provider_without_sts_audience" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  variables {
    enabled              = true
    create_oidc_provider = false
  }

  override_data {
    target = data.aws_iam_openid_connect_provider.existing
    values = {
      arn            = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      client_id_list = ["https://github.com/Torres21C"]
    }
  }

  expect_failures = [data.aws_iam_openid_connect_provider.existing]
}

run "publisher_disabled_reads_nothing" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  variables {
    create_oidc_provider = false
  }

  assert {
    condition     = length(data.aws_iam_openid_connect_provider.existing) == 0 && length(aws_iam_role.publisher) == 0
    error_message = "Desactivado, el módulo no lee ni crea nada."
  }
}

run "publisher_rejects_legacy_subject_format" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  variables {
    oidc_subject_prefix = "repo:Torres21C/spectra-shop"
  }

  expect_failures = [var.oidc_subject_prefix]
}

run "publisher_rejects_wildcard_subject" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  variables {
    oidc_subject_prefix = "repo:Torres21C@84191196/*"
  }

  expect_failures = [var.oidc_subject_prefix]
}

run "publisher_rejects_wildcard_environment" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  variables {
    github_environment = "*"
  }

  expect_failures = [var.github_environment]
}

run "publisher_rejects_ref_context_instead_of_environment" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  variables {
    github_environment = "ecr-publish-lab:ref:refs/heads/main"
  }

  expect_failures = [var.github_environment]
}

run "publisher_rejects_wildcard_repository" {
  command = plan

  module {
    source = "../modules/github_oidc_publisher"
  }

  variables {
    repository_arns = { all = "arn:aws:ecr:us-east-1:111122223333:repository/*" }
  }

  expect_failures = [var.repository_arns]
}
