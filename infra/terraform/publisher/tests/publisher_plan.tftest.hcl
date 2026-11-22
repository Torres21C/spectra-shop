# Raíz infra/terraform/publisher (PR-6.2) con proveedor AWS SIMULADO: `terraform test` no usa credenciales
# ni contacta con AWS. Solo `command = plan`. Comprueba lo que crea esta raíz por sí sola (sin lab): los 5
# repositorios y, si se habilita, el rol publicador con permisos solo sobre ellos. Que no pueda crear ECS,
# RDS, ALB, VPC, CloudFront, WAF ni Secrets Manager lo comprueba scripts/check_state_ownership.py.

mock_provider "aws" {
  mock_resource "aws_ecr_repository" {
    override_during = plan
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:111122223333:repository/spectra/mock"
      repository_url = "111122223333.dkr.ecr.us-east-1.amazonaws.com/spectra/mock"
    }
  }

  mock_resource "aws_iam_openid_connect_provider" {
    override_during = plan
    defaults = {
      arn = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  mock_resource "aws_iam_role" {
    override_during = plan
    defaults = {
      arn = "arn:aws:iam::111122223333:role/spectra-lab-ecr-publisher"
      id  = "spectra-lab-ecr-publisher"
    }
  }

  mock_data "aws_iam_openid_connect_provider" {
    defaults = {
      arn            = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      client_id_list = ["sts.amazonaws.com"]
    }
  }
}

run "repositories_only_by_default" {
  command = plan

  assert {
    condition = output.ecr_repository_names == {
      "identity-service" = "spectra/identity-service"
      "catalog-service"  = "spectra/catalog-service"
      "commerce-service" = "spectra/commerce-service"
      "audit-service"    = "spectra/audit-service"
      "db-ops"           = "spectra/db-ops"
    }
    error_message = "La raíz crea exactamente los 5 repositorios que consumen las 9 imágenes y las task definitions."
  }

  assert {
    condition     = output.ecr_publisher_role_arn == null && output.github_oidc_provider_arn == null && output.github_oidc_provider_managed_here == false
    error_message = "Sin enable_ecr_publisher no se crean el rol ni el proveedor OIDC."
  }

  assert {
    condition     = output.ecr_publisher_oidc_subject == "repo:Torres21C@84191196/spectra-shop@1457499804:environment:ecr-publish-lab"
    error_message = "El sub aceptado es el del Environment ecr-publish-lab de este repositorio (formato inmutable)."
  }
}

run "publisher_enabled_creates_role_scoped_to_repositories" {
  command = plan

  variables {
    enable_ecr_publisher = true
  }

  assert {
    condition     = output.ecr_publisher_role_arn == "arn:aws:iam::111122223333:role/spectra-lab-ecr-publisher"
    error_message = "El rol se llama spectra-lab-ecr-publisher: es el ARN que exigen check-publish-config.sh y publish-images.sh."
  }

  assert {
    condition     = output.github_oidc_provider_managed_here == true
    error_message = "Sin proveedor previo, esta raíz crea y administra el proveedor OIDC de la cuenta."
  }

  assert {
    condition     = toset(jsondecode(module.ecr_publisher.publish_policy_json).Statement[1].Resource) == toset(values(output.ecr_repository_arns))
    error_message = "La publicación se limita a los repositorios creados por esta raíz."
  }

  assert {
    condition     = length(regexall("\"(iam|ecs|rds|kms|secretsmanager|s3|sts|elasticloadbalancing|cloudfront|wafv2|ec2|logs):|ecr:\\*|\"\\*:|Delete", module.ecr_publisher.publish_policy_json)) == 0
    error_message = "El rol no tiene permisos de IAM, ECS, RDS, KMS, Secrets Manager, S3, STS, ELB, CloudFront, WAF, EC2 ni logs, ni de borrado."
  }
}

run "publisher_with_existing_oidc_provider" {
  command = plan

  variables {
    enable_ecr_publisher        = true
    create_github_oidc_provider = false
  }

  assert {
    condition     = output.github_oidc_provider_managed_here == false && output.github_oidc_provider_arn == "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
    error_message = "D3: con un proveedor existente, la raíz lo usa (leído por URL) y no lo administra."
  }
}

run "rejects_other_region" {
  command = plan

  variables {
    aws_region = "eu-west-1"
  }

  expect_failures = [var.aws_region]
}
