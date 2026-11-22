# Pruebas estáticas del entorno lab con proveedores SIMULADOS: `terraform test` no usa credenciales ni
# contacta con AWS. Solo `command = plan` (nunca apply). Validan variables, cableado entre módulos y
# propiedades de seguridad que se pueden comprobar sin una cuenta real.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111122223333"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  # PR-6.2: lab solo LEE los repositorios ECR de infra/terraform/publisher.
  mock_data "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:111122223333:repository/spectra/mock"
      repository_url = "111122223333.dkr.ecr.us-east-1.amazonaws.com/spectra/mock"
    }
  }

  mock_data "aws_kms_public_key" {
    defaults = {
      public_key_pem = "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----\n"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      domain_name = "d111111abcdef8.cloudfront.net"
      arn         = "arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE"
    }
  }
}

mock_provider "random" {}

variables {
  image_tag = "0123456789abcdef0123456789abcdef01234567"
}

run "plan_with_defaults" {
  command = plan

  assert {
    condition     = output.run_task_network_configuration.assignPublicIp == "DISABLED"
    error_message = "Las tareas de operación no deben recibir IP pública."
  }

  assert {
    condition     = length(output.ops_task_definition_families) == 6
    error_message = "Deben existir las 6 tareas DT-09 (provision, 4 migrate, finalize)."
  }

  assert {
    condition     = keys(data.aws_ecr_repository.this) == ["audit-service", "catalog-service", "commerce-service", "db-ops", "identity-service"]
    error_message = "PR-6.2: lab lee exactamente los 5 repositorios de infra/terraform/publisher."
  }

  assert {
    condition     = alltrue([for name, repo in data.aws_ecr_repository.this : repo.name == "spectra/${name}"])
    error_message = "PR-6.2: los repositorios se leen por su nombre spectra/<repositorio>, el mismo que crea publisher."
  }

  assert {
    condition     = length(output.ecr_repository_urls) == 5
    error_message = "PR-6.2: las task definitions usan las URL de los repositorios leídos."
  }
}

run "rejects_trust_proxy_true" {
  command = plan

  variables {
    trust_proxy = "true"
  }

  expect_failures = [var.trust_proxy]
}

run "accepts_trust_proxy_alternatives" {
  command = plan

  variables {
    trust_proxy = "10.20.0.0/16"
  }
}

run "rejects_unsupported_vpc_origin_az" {
  command = plan

  variables {
    az_ids = ["use1-az1", "use1-az3"]
  }

  expect_failures = [var.az_ids]
}

run "rejects_mutable_image_tag" {
  command = plan

  variables {
    image_tag = "latest"
  }

  expect_failures = [var.image_tag]
}

run "rejects_other_region" {
  command = plan

  variables {
    aws_region = "eu-west-1"
  }

  expect_failures = [var.aws_region]
}

run "rejects_domain_without_certificate" {
  command = plan

  variables {
    domain_name = "shop.example.invalid"
  }

  expect_failures = [var.acm_certificate_arn]
}
