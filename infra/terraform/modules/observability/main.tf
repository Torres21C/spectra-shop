# Observabilidad del laboratorio (AWS-21, plan §14 EV-AWS-LAB-OBS, AWS-29 R27):
#   - Un log group cifrado por carga de trabajo (/spectra/<entorno>/<carga>), con retención fija.
#   - Filtros de métricas sobre eventos que el código SÍ emite (main a0f8052):
#       commerce  checkout_saga_stuck, inventory_fulfillment_stuck (DT-08 / R27)
#       identity  identity_unhandled_exception
#       catalog   audit_relay_deferred (relay de la outbox hacia Audit)
#     Los logs de Nest no son JSON puro (llevan prefijo), así que se usan términos de texto entre comillas.
#   - Alarmas del ALB, de los target groups y de RDS, con notificación por SNS cifrado.
#   - AWS Budgets con avisos (plan §3: antes del primer recurso).

locals {
  log_metric_filters = {
    checkout-saga-stuck = {
      workload = "commerce"
      pattern  = "\"checkout_saga_stuck\""
      metric   = "CheckoutSagaStuck"
    }
    inventory-fulfillment-stuck = {
      workload = "commerce"
      pattern  = "\"inventory_fulfillment_stuck\""
      metric   = "InventoryFulfillmentStuck"
    }
    identity-unhandled-exception = {
      workload = "identity"
      pattern  = "\"identity_unhandled_exception\""
      metric   = "IdentityUnhandledException"
    }
    audit-relay-deferred = {
      workload = "catalog"
      pattern  = "\"audit_relay_deferred\""
      metric   = "AuditRelayDeferred"
    }
  }

  metric_namespace = "SPECTRA/${var.environment}"
  alarm_actions    = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_log_group" "workload" {
  # checkov:skip=CKV_AWS_338:Retención de 30 días en el laboratorio (plan §5, paso 8; costo). Exportar a la bóveda las evidencias necesarias antes de que expiren.
  for_each = toset(var.workloads)

  name              = "/spectra/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_cloudwatch_log_metric_filter" "event" {
  for_each = local.log_metric_filters

  name           = "${var.name_prefix}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.workload[each.value.workload].name
  pattern        = each.value.pattern

  metric_transformation {
    name          = each.value.metric
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name_prefix}-alarms"
  kms_master_key_id = var.kms_key_arn
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alarm_email == null ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "event" {
  for_each = local.log_metric_filters

  alarm_name          = "${var.name_prefix}-${each.key}"
  alarm_description   = "Evento ${each.value.metric} en ${each.value.workload}-service (revisar runbook)"
  namespace           = local.metric_namespace
  metric_name         = each.value.metric
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  depends_on = [aws_cloudwatch_log_metric_filter.event]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  for_each = {
    elb    = "HTTPCode_ELB_5XX_Count"
    target = "HTTPCode_Target_5XX_Count"
  }

  alarm_name          = "${var.name_prefix}-alb-${each.key}-5xx"
  alarm_description   = "Respuestas 5xx (${each.value}) en el ALB interno"
  namespace           = "AWS/ApplicationELB"
  metric_name         = each.value
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.alb_5xx_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  for_each = var.target_group_arn_suffixes

  alarm_name        = "${var.name_prefix}-${each.key}-unhealthy"
  alarm_description = "${each.key}-service con destinos no saludables (/health/ready)"
  namespace         = "AWS/ApplicationELB"
  metric_name       = "UnHealthyHostCount"
  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = each.value
  }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name_prefix}-rds-cpu"
  alarm_description   = "CPU de RDS por encima del 80 %"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.db_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${var.name_prefix}-rds-free-storage"
  alarm_description   = "Menos de 2 GB libres en RDS"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.db_identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 2147483648
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Presupuesto mensual de la cuenta (no depende de etiquetas de asignación de costos activadas).
resource "aws_budgets_budget" "monthly" {
  count = length(var.budget_emails) > 0 ? 1 : 0

  name         = "${var.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = toset(var.budget_alert_percentages)

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = var.budget_emails
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_emails
  }
}
