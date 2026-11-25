# Propiedades de seguridad de los módulos, con proveedores simulados y solo `plan`.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

mock_provider "random" {}

run "network_is_private" {
  command = plan

  module {
    source = "../../modules/network"
  }

  variables {
    name_prefix              = "spectra-lab"
    environment              = "lab"
    region                   = "us-east-1"
    account_id               = "111122223333"
    vpc_cidr                 = "10.20.0.0/16"
    az_ids                   = ["use1-az1", "use1-az2"]
    app_subnet_cidrs         = ["10.20.1.0/24", "10.20.2.0/24"]
    data_subnet_cidrs        = ["10.20.11.0/24", "10.20.12.0/24"]
    enable_flow_logs         = true
    log_retention_days       = 30
    logs_kms_key_arn         = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"
    permissions_boundary_arn = "arn:aws:iam::111122223333:policy/spectra-lab-runtime-boundary"
  }

  assert {
    condition = alltrue(concat(
      [for s in aws_subnet.app : s.map_public_ip_on_launch == false],
      [for s in aws_subnet.data : s.map_public_ip_on_launch == false],
    ))
    error_message = "Ninguna subred puede asignar IP públicas."
  }

  assert {
    condition     = toset([for s in aws_subnet.app : s.availability_zone_id]) == toset(["use1-az1", "use1-az2"])
    error_message = "Las subredes deben fijarse por AZ ID."
  }

  assert {
    condition     = aws_iam_role.flow_logs[0].permissions_boundary == "arn:aws:iam::111122223333:policy/spectra-lab-runtime-boundary"
    error_message = "El rol de VPC Flow Logs debe llevar la permissions boundary obligatoria."
  }

  # La ausencia de rutas (ni aws_route ni bloques route) se comprueba de forma estática en
  # scripts/static-checks.sh: el atributo `route` es calculado y no se conoce en el plan.
}

run "security_groups_have_no_open_cidrs" {
  command = plan

  module {
    source = "../../modules/security_groups"
  }

  variables {
    name_prefix        = "spectra-lab"
    vpc_id             = "vpc-0123456789abcdef0"
    s3_prefix_list_id  = "pl-63a5400a"
    alb_ingress_source = "prefix_list"
  }

  assert {
    condition = alltrue(concat(
      [for r in aws_vpc_security_group_ingress_rule.service_from_alb : r.cidr_ipv4 == null && r.cidr_ipv6 == null],
      [for r in aws_vpc_security_group_ingress_rule.internal : r.cidr_ipv4 == null && r.cidr_ipv6 == null],
      [for r in aws_vpc_security_group_ingress_rule.rds_from_client : r.cidr_ipv4 == null && r.cidr_ipv6 == null],
      [for r in aws_vpc_security_group_ingress_rule.endpoints_from_client : r.cidr_ipv4 == null && r.cidr_ipv6 == null],
      [for r in aws_vpc_security_group_ingress_rule.alb_from_cloudfront_prefix_list : r.cidr_ipv4 == null && r.cidr_ipv6 == null],
    ))
    error_message = "Ninguna regla de entrada puede usar un CIDR (solo SG o prefix lists)."
  }

  assert {
    condition     = toset([for r in aws_vpc_security_group_ingress_rule.internal : r.from_port]) == toset([3101, 3102, 3104])
    error_message = "Solo los puertos internos reales (3101, 3102, 3104) tienen reglas entre servicios."
  }

  assert {
    condition     = toset([for r in aws_vpc_security_group_ingress_rule.service_from_alb : r.from_port]) == toset([3001, 3002, 3003, 3004])
    error_message = "El ALB solo alcanza los puertos públicos."
  }


}

run "secrets_never_planned_in_clear" {
  command = plan

  module {
    source = "../../modules/secrets"
  }

  variables {
    secret_prefix         = "spectra/lab/20261122-a"
    kms_key_arn           = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"
    recovery_window_days  = 7
    db_address            = "spectra-lab-db.example.us-east-1.rds.amazonaws.com"
    db_port               = 5432
    db_name               = "spectra_shop"
    connection_limit      = 5
    synthetic_admin_email = "admin@spectra.test"
    secret_versions       = {}
  }

  # Los atributos write-only siempre son null en el plan y en el state.
  assert {
    condition = alltrue(concat(
      [for v in aws_secretsmanager_secret_version.db_role : v.secret_string_wo == null && v.secret_string == null],
      [for v in aws_secretsmanager_secret_version.token : v.secret_string_wo == null && v.secret_string == null],
      [for v in aws_secretsmanager_secret_version.synthetic_admin : v.secret_string_wo == null && v.secret_string == null],
    ))
    error_message = "Ningún valor secreto puede aparecer en el plan."
  }

  assert {
    condition     = length(aws_secretsmanager_secret.db_role) == 8
    error_message = "DT-09 requiere 8 secretos de rol."
  }

  assert {
    condition     = alltrue([for v in aws_secretsmanager_secret_version.db_role : v.secret_string_wo_version == 1])
    error_message = "La versión inicial de cada secreto debe ser 1."
  }

  assert {
    condition = alltrue(concat(
      [for secret in aws_secretsmanager_secret.db_role : startswith(secret.name, "spectra/lab/20261122-a/") && secret.recovery_window_in_days == 7],
      [for secret in aws_secretsmanager_secret.token : startswith(secret.name, "spectra/lab/20261122-a/") && secret.recovery_window_in_days == 7],
      [for secret in aws_secretsmanager_secret.synthetic_admin : startswith(secret.name, "spectra/lab/20261122-a/") && secret.recovery_window_in_days == 7],
    ))
    error_message = "Los secretos deben aislarse por ciclo y conservar siete días de recuperación."
  }
}

run "database_always_discards_final_snapshot" {
  command = plan

  module {
    source = "../../modules/database"
  }

  variables {
    identifier                = "spectra-lab-db"
    engine_version            = "16"
    instance_class            = "db.t4g.micro"
    db_name                   = "spectra_shop"
    master_username           = "spectra_admin"
    allocated_storage_gb      = 20
    max_allocated_storage_gb  = 20
    subnet_ids                = ["subnet-aaaa", "subnet-bbbb"]
    rds_sg_id                 = "sg-0123456789abcdef0"
    kms_key_arn               = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"
    ca_cert_identifier        = "rds-ca-rsa2048-g1"
    backup_retention_days     = 1
    deletion_protection       = false
    skip_final_snapshot       = true
    final_snapshot_identifier = "this-value-must-be-ignored"
    apply_immediately         = true
    log_retention_days        = 30
  }

  assert {
    condition     = aws_db_instance.this.skip_final_snapshot && aws_db_instance.this.final_snapshot_identifier == null
    error_message = "El recurso RDS debe omitir el snapshot final y anular cualquier identificador cuando synthetic-discard está activo."
  }

  assert {
    condition     = output.skip_final_snapshot == aws_db_instance.this.skip_final_snapshot
    error_message = "El output skip_final_snapshot debe reflejar el recurso RDS, no un valor fijo."
  }
}

run "database_output_reflects_resource_snapshot_policy" {
  command = plan

  module {
    source = "../../modules/database"
  }

  variables {
    identifier                = "spectra-lab-db"
    engine_version            = "16"
    instance_class            = "db.t4g.micro"
    db_name                   = "spectra_shop"
    master_username           = "spectra_admin"
    allocated_storage_gb      = 20
    max_allocated_storage_gb  = 20
    subnet_ids                = ["subnet-aaaa", "subnet-bbbb"]
    rds_sg_id                 = "sg-0123456789abcdef0"
    kms_key_arn               = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"
    ca_cert_identifier        = "rds-ca-rsa2048-g1"
    backup_retention_days     = 1
    deletion_protection       = true
    skip_final_snapshot       = false
    final_snapshot_identifier = "module-generic-case"
    apply_immediately         = true
    log_retention_days        = 30
  }

  # El módulo es genérico; la raíz lab fija skip_final_snapshot=true (lo comprueban lab_plan y
  # check_state_ownership). Esta ejecución impide que el output oculte el valor real del recurso.
  assert {
    condition     = !output.skip_final_snapshot && !aws_db_instance.this.skip_final_snapshot
    error_message = "El output skip_final_snapshot debe reflejar el recurso RDS, no un valor fijo."
  }
}
