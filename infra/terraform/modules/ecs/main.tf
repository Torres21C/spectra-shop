# Cómputo: clúster ECS Fargate, descubrimiento de servicios (Cloud Map), task definitions y servicios.
#
# Ciclo de vida (ADR-AWS-05 D-AWS-05-10):
#   1. Primer `apply` con service_desired_count = 0: se crea todo, pero no arranca ninguna tarea.
#   2. Operación manual (PR-7): run-task db-provision → 4 × *-migrate → db-finalize → verificación DT-09.
#   3. Segundo `apply` con service_desired_count = 1.
# Ninguna tarea de servicio migra ni siembra al arrancar (DT-09).

locals {
  sorted_env = {
    for name in keys(local.services) : name => [
      for key in sort(keys(local.services[name].environment)) : { name = key, value = local.services[name].environment[key] }
    ]
  }

  ops_env = {
    for name in keys(local.ops) : name => [
      for key in sort(keys(local.ops[name].environment)) : { name = key, value = local.ops[name].environment[key] }
    ]
  }

  # valueFrom con clave JSON: "<arn>:<clave>::" (sin etapa ni versión = AWSCURRENT).
  workload_secrets = {
    for name, w in local.workloads : name => [
      for env_name in sort(keys(w.secrets)) : {
        name      = env_name
        valueFrom = w.secrets[env_name].key == null ? w.secrets[env_name].arn : "${w.secrets[env_name].arn}:${w.secrets[env_name].key}::"
      }
    ]
  }

  linux_parameters = {
    initProcessEnabled = true
    capabilities = {
      add  = []
      drop = ["ALL"]
    }
  }
}

resource "aws_ecs_cluster" "this" {
  # checkov:skip=CKV_AWS_65:Container Insights tiene costo; se activa con la variable container_insights (por defecto desactivado en el laboratorio).
  name = var.cluster_name

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = var.service_discovery_namespace
  description = "Descubrimiento de servicios interno de ${var.name_prefix} (AWS-06)"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "this" {
  for_each = toset([for name in keys(local.services) : name if local.services[name].discovery])

  name = each.key

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"

    dns_records {
      ttl  = 10
      type = "A"
    }
  }
}

# ---------------------------------------------------------------------------------------------------------
# Task definitions de los servicios
# ---------------------------------------------------------------------------------------------------------
resource "aws_ecs_task_definition" "service" {
  for_each = toset(keys(local.services))

  family                   = "${var.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.service_sizes[each.key].cpu)
  memory                   = tostring(var.service_sizes[each.key].memory)
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = local.services[each.key].task_role ? aws_iam_role.identity_task.arn : null

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${var.repository_urls[local.services[each.key].repository]}:${var.image_tag}"
      essential = true

      portMappings = concat(
        [{ containerPort = local.services[each.key].port, protocol = "tcp" }],
        local.services[each.key].internal_port == null ? [] : [{ containerPort = local.services[each.key].internal_port, protocol = "tcp" }],
      )

      environment = local.sorted_env[each.key]
      secrets     = local.workload_secrets[each.key]

      readonlyRootFilesystem = var.readonly_root_filesystem
      linuxParameters        = local.linux_parameters
      stopTimeout            = 30

      # Vida (estática); la disponibilidad real la decide el ALB con /health/ready.
      healthCheck = {
        command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:${local.services[each.key].port}/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = var.log_group_names[each.key]
          awslogs-region        = var.region
          awslogs-stream-prefix = each.key
        }
      }
    }
  ])
}

# ---------------------------------------------------------------------------------------------------------
# Task definitions de operación (run-task manual; nunca automáticas)
# ---------------------------------------------------------------------------------------------------------
resource "aws_ecs_task_definition" "ops" {
  for_each = toset(keys(local.ops))

  family                   = "${var.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.ops_size.cpu)
  memory                   = tostring(var.ops_size.memory)
  execution_role_arn       = aws_iam_role.execution[each.key].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${var.repository_urls[local.ops[each.key].repository]}:${local.ops[each.key].image_tag}"
      essential = true
      command   = local.ops[each.key].command

      environment = local.ops_env[each.key]
      secrets     = local.workload_secrets[each.key]

      # Prisma CLI y psql no se han validado con raíz de solo lectura; se mantiene escribible (ver README).
      readonlyRootFilesystem = false
      linuxParameters        = local.linux_parameters

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = var.log_group_names[each.key]
          awslogs-region        = var.region
          awslogs-stream-prefix = each.key
        }
      }
    }
  ])
}

# ---------------------------------------------------------------------------------------------------------
# Servicios
# ---------------------------------------------------------------------------------------------------------
resource "aws_ecs_service" "this" {
  for_each = toset(keys(local.services))

  name             = each.key
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.service[each.key].arn
  desired_count    = var.service_desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  enable_execute_command            = false
  enable_ecs_managed_tags           = true
  propagate_tags                    = "SERVICE"
  health_check_grace_period_seconds = 60
  wait_for_steady_state             = false

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.service_sg_ids[each.key]]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arns[each.key]
    container_name   = each.key
    container_port   = local.services[each.key].port
  }

  dynamic "service_registries" {
    for_each = local.services[each.key].discovery ? [aws_service_discovery_service.this[each.key].arn] : []

    content {
      registry_arn = service_registries.value
    }
  }

  depends_on = [aws_iam_role_policy.execution, aws_iam_role_policy.identity_task]
}
