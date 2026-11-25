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
  image_tag                         = "0123456789abcdef0123456789abcdef01234567"
  lab_cycle_id                      = "20261122-a"
  lab_role_permissions_boundary_arn = "arn:aws:iam::111122223333:policy/spectra-lab-runtime-boundary"
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

  assert {
    condition     = output.lab_cycle_id == "20261122-a" && output.lab_data_policy == "synthetic-discard" && !output.teardown_mode
    error_message = "El identificador del ciclo y la política sintética deben quedar disponibles para las evidencias."
  }

  assert {
    condition     = output.rds_skip_final_snapshot
    error_message = "synthetic-discard debe omitir siempre el snapshot final cifrado con la CMK efímera."
  }

  assert {
    condition     = alltrue([for name in output.secret_names : startswith(name, "spectra/lab/20261122-a/")])
    error_message = "Todos los secretos deben quedar aislados bajo el identificador del ciclo."
  }


  assert {
    condition     = output.lab_role_permissions_boundary_arn == "arn:aws:iam::111122223333:policy/spectra-lab-runtime-boundary"
    error_message = "La boundary obligatoria debe quedar fijada y expuesta para evidencia."
  }
}

run "rejects_wrong_permissions_boundary" {
  command = plan

  variables {
    lab_role_permissions_boundary_arn = "arn:aws:iam::111122223333:policy/another-boundary"
  }

  expect_failures = [var.lab_role_permissions_boundary_arn]
}

run "rejects_invalid_lab_cycle_id" {
  command = plan

  variables {
    lab_cycle_id = "Cycle_2026!"
  }

  expect_failures = [var.lab_cycle_id]
}

run "second_cycle_uses_disjoint_secret_names" {
  command = plan

  variables {
    lab_cycle_id = "20261122-b"
  }

  assert {
    condition = alltrue([
      for name in output.secret_names :
      startswith(name, "spectra/lab/20261122-b/") && !startswith(name, "spectra/lab/20261122-a/")
    ])
    error_message = "Una reconstrucción debe usar nombres de secretos disjuntos del ciclo anterior."
  }
}

run "rejects_snapshot_retention_policy" {
  command = plan

  variables {
    lab_data_policy = "retain-final-snapshot"
  }

  expect_failures = [var.lab_data_policy]
}

run "rejects_immediate_secret_deletion" {
  command = plan

  variables {
    secret_recovery_window_days = 0
  }

  expect_failures = [var.secret_recovery_window_days]
}

run "rejects_kms_deletion_before_secret_recovery" {
  command = plan

  variables {
    secret_recovery_window_days = 14
    kms_deletion_window_days    = 7
  }

  expect_failures = [var.kms_deletion_window_days]
}

run "rejects_equal_kms_and_secret_windows" {
  command = plan

  variables {
    secret_recovery_window_days = 7
    kms_deletion_window_days    = 7
  }

  expect_failures = [var.kms_deletion_window_days]
}

run "accepts_complete_teardown_configuration" {
  command = plan

  variables {
    teardown_mode            = true
    service_desired_count    = 0
    db_deletion_protection   = false
    spa_bucket_force_destroy = true
    alb_deletion_protection  = false
  }
}

run "rejects_incomplete_teardown_configuration" {
  command = plan

  variables {
    teardown_mode            = true
    db_deletion_protection   = false
    service_desired_count    = 1
    spa_bucket_force_destroy = true
  }

  expect_failures = [var.teardown_mode]
}

run "rejects_teardown_with_protected_rds" {
  command = plan

  variables {
    teardown_mode            = true
    service_desired_count    = 0
    db_deletion_protection   = true
    spa_bucket_force_destroy = true
    alb_deletion_protection  = false
  }

  expect_failures = [var.teardown_mode]
}

run "rejects_teardown_without_spa_force_destroy" {
  command = plan

  variables {
    teardown_mode            = true
    service_desired_count    = 0
    db_deletion_protection   = false
    spa_bucket_force_destroy = false
    alb_deletion_protection  = false
  }

  expect_failures = [var.teardown_mode]
}

run "rejects_teardown_with_protected_alb" {
  command = plan

  variables {
    teardown_mode            = true
    service_desired_count    = 0
    db_deletion_protection   = false
    spa_bucket_force_destroy = true
    alb_deletion_protection  = true
  }

  expect_failures = [var.teardown_mode]
}

run "rejects_normal_configuration_with_spa_force_destroy" {
  command = plan

  variables {
    teardown_mode            = false
    db_deletion_protection   = true
    spa_bucket_force_destroy = true
  }

  expect_failures = [var.teardown_mode]
}

run "rejects_weakened_normal_configuration" {
  command = plan

  variables {
    teardown_mode          = false
    db_deletion_protection = false
  }

  expect_failures = [var.teardown_mode]
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
