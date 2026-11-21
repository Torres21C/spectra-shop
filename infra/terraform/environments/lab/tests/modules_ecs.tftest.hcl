# Propiedades de las task definitions y los servicios ECS (proveedores simulados, solo `plan`).

mock_provider "aws" {
  mock_resource "aws_iam_role" {
    override_during = plan
    defaults = {
      arn = "arn:aws:iam::111122223333:role/mock-role"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  name_prefix    = "spectra-lab"
  region         = "us-east-1"
  account_id     = "111122223333"
  cluster_name   = "spectra-lab"
  vpc_id         = "vpc-0123456789abcdef0"
  app_subnet_ids = ["subnet-aaaa", "subnet-bbbb"]
  service_sg_ids = { identity = "sg-id", catalog = "sg-ca", commerce = "sg-co", audit = "sg-au" }
  target_group_arns = {
    for s in ["identity", "catalog", "commerce", "audit"] :
    s => "arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/spectra-lab-api-${s}/0123456789abcdef"
  }
  service_discovery_namespace = "spectra.internal"
  repository_urls = {
    identity-service = "111122223333.dkr.ecr.us-east-1.amazonaws.com/spectra/identity-service"
    catalog-service  = "111122223333.dkr.ecr.us-east-1.amazonaws.com/spectra/catalog-service"
    commerce-service = "111122223333.dkr.ecr.us-east-1.amazonaws.com/spectra/commerce-service"
    audit-service    = "111122223333.dkr.ecr.us-east-1.amazonaws.com/spectra/audit-service"
    db-ops           = "111122223333.dkr.ecr.us-east-1.amazonaws.com/spectra/db-ops"
  }
  repository_arns = {
    identity-service = "arn:aws:ecr:us-east-1:111122223333:repository/spectra/identity-service"
    catalog-service  = "arn:aws:ecr:us-east-1:111122223333:repository/spectra/catalog-service"
    commerce-service = "arn:aws:ecr:us-east-1:111122223333:repository/spectra/commerce-service"
    audit-service    = "arn:aws:ecr:us-east-1:111122223333:repository/spectra/audit-service"
    db-ops           = "arn:aws:ecr:us-east-1:111122223333:repository/spectra/db-ops"
  }
  image_tag             = "0123456789abcdef0123456789abcdef01234567"
  cpu_architecture      = "X86_64"
  service_desired_count = 1
  service_sizes = {
    identity = { cpu = 512, memory = 1024 }
    catalog  = { cpu = 256, memory = 512 }
    commerce = { cpu = 256, memory = 512 }
    audit    = { cpu = 256, memory = 512 }
  }
  ops_size                 = { cpu = 256, memory = 512 }
  readonly_root_filesystem = true
  container_insights       = false
  log_group_names = {
    for w in ["identity", "catalog", "commerce", "audit", "db-provision", "identity-migrate", "catalog-migrate", "commerce-migrate", "audit-migrate", "db-finalize"] :
    w => "/spectra/lab/${w}"
  }
  log_group_arns = {
    for w in ["identity", "catalog", "commerce", "audit", "db-provision", "identity-migrate", "catalog-migrate", "commerce-migrate", "audit-migrate", "db-finalize"] :
    w => "arn:aws:logs:us-east-1:111122223333:log-group:/spectra/lab/${w}"
  }
  data_kms_key_arn   = "arn:aws:kms:us-east-1:111122223333:key/data"
  jwt_key_arn        = "arn:aws:kms:us-east-1:111122223333:key/jwt"
  jwt_public_key_pem = "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----\n"
  public_origin      = "https://d111111abcdef8.cloudfront.net"
  trust_proxy        = "false"
  db_address         = "spectra-lab-db.example.us-east-1.rds.amazonaws.com"
  db_port            = 5432
  db_name            = "spectra_shop"
  master_secret_arn  = "arn:aws:secretsmanager:us-east-1:111122223333:secret:rds!db-master"
  db_role_secret_arns = {
    for r in ["identity-migrator", "identity-app", "catalog-migrator", "catalog-app", "commerce-migrator", "commerce-app", "audit-migrator", "audit-app"] :
    r => "arn:aws:secretsmanager:us-east-1:111122223333:secret:spectra/lab/db/${r}"
  }
  internal_token_secret_arn  = "arn:aws:secretsmanager:us-east-1:111122223333:secret:spectra/lab/internal-token"
  inventory_token_secret_arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:spectra/lab/inventory-token"
  synthetic_admin_secret_arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:spectra/lab/synthetic-admin"
  catalog_seed_demo_products = false
}

run "ecs_task_security" {
  command = plan

  module {
    source = "../../modules/ecs"
  }

  assert {
    condition     = alltrue([for s in aws_ecs_service.this : s.network_configuration[0].assign_public_ip == false])
    error_message = "Ningún servicio puede tener IP pública."
  }

  assert {
    condition     = alltrue([for s in aws_ecs_service.this : s.enable_execute_command == false])
    error_message = "ECS Exec debe estar desactivado."
  }

  # Ninguna credencial viaja en `environment` (solo en `secrets`).
  assert {
    condition = alltrue(flatten([
      for td in concat(values(aws_ecs_task_definition.service), values(aws_ecs_task_definition.ops)) : [
        for e in jsondecode(td.container_definitions)[0].environment :
        length(regexall("(PASSWORD|TOKEN|DATABASE_URL|PGUSER|PRIVATE)", e.name)) == 0
      ]
    ]))
    error_message = "Una variable con credenciales está en environment en lugar de secrets."
  }

  # Solo identity-service tiene rol de tarea (kms:Sign); el resto no recibe credenciales AWS.
  assert {
    condition = (
      aws_ecs_task_definition.service["identity"].task_role_arn != null &&
      alltrue([for name in ["catalog", "commerce", "audit"] : aws_ecs_task_definition.service[name].task_role_arn == null]) &&
      alltrue([for td in aws_ecs_task_definition.ops : td.task_role_arn == null])
    )
    error_message = "Solo identity-service debe tener rol de tarea."
  }

  # Cada servicio inyecta solo los secretos de SU rol de base de datos.
  assert {
    condition = alltrue([
      for name in ["identity", "catalog", "commerce", "audit"] : alltrue([
        for s in jsondecode(aws_ecs_task_definition.service[name].container_definitions)[0].secrets :
        !strcontains(s.valueFrom, "/db/") || strcontains(s.valueFrom, "/db/${name}-app")
      ])
    ])
    error_message = "Un servicio inyecta el secreto de base de datos de otro servicio o de un migrador."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.service["identity"].container_definitions)[0].readonlyRootFilesystem == true
    error_message = "Los servicios deben usar raíz de solo lectura cuando la variable lo indica."
  }

  assert {
    condition = alltrue([
      for td in aws_ecs_task_definition.service :
      jsondecode(td.container_definitions)[0].linuxParameters.capabilities.drop == ["ALL"]
    ])
    error_message = "Las tareas deben eliminar todas las capacidades Linux."
  }

  # Las migraciones usan la imagen <sha>-migrate; los servicios, <sha>.
  assert {
    condition = (
      endswith(jsondecode(aws_ecs_task_definition.ops["identity-migrate"].container_definitions)[0].image, ":0123456789abcdef0123456789abcdef01234567-migrate") &&
      endswith(jsondecode(aws_ecs_task_definition.service["identity"].container_definitions)[0].image, ":0123456789abcdef0123456789abcdef01234567")
    )
    error_message = "Etiquetas de imagen incorrectas."
  }

  # AWS-25: sin seed de demostración cuando la variable es false.
  assert {
    condition     = !strcontains(join(" ", jsondecode(aws_ecs_task_definition.ops["catalog-migrate"].container_definitions)[0].command), "seed.js")
    error_message = "catalog-migrate no debe sembrar productos con catalog_seed_demo_products = false."
  }

  # TRUST_PROXY, cookies Secure y origen único en los cuatro listeners públicos.
  assert {
    condition = alltrue([
      for td in aws_ecs_task_definition.service : length([
        for e in jsondecode(td.container_definitions)[0].environment : e
        if(e.name == "TRUST_PROXY" && e.value == "false") || (e.name == "COOKIE_SECURE" && e.value == "true") || (e.name == "CORS_ORIGINS" && e.value == "https://d111111abcdef8.cloudfront.net")
      ]) == 3
    ])
    error_message = "Faltan TRUST_PROXY, COOKIE_SECURE=true o CORS_ORIGINS en algún servicio."
  }

  # db-provision recibe las 8 contraseñas de rol y las credenciales del maestro.
  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.ops["db-provision"].container_definitions)[0].secrets) == 10
    error_message = "db-provision debe recibir PGUSER, PGPASSWORD y 8 contraseñas de rol."
  }
}
