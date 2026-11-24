# Presupuesto mensual de la CUENTA (PR-6.2, D7; ADR-AWS-05 D-AWS-05-21). Se crea en el bootstrap porque es la
# primera raíz que se aplica: así existe antes de cualquier recurso facturable (KMS, ECR y laboratorio).
#
# Es solo un AVISO por correo: AWS Budgets no detiene ni limita el gasto (no hay acciones configuradas), y
# sus datos llegan con retraso (hasta unas horas). Independiente del presupuesto del laboratorio
# (environments/lab, módulo observability, "spectra-lab-monthly"); no comparten recursos ni state.

resource "aws_budgets_budget" "account" {
  name         = "spectra-account-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Mide el consumo antes de créditos y reembolsos: si se descontaran, el gasto neto podría quedar en 0 y los
  # avisos no llegarían mientras se agotan los créditos. El resto son los valores por defecto de AWS, explícitos
  # para que no dependan de cómo complete el proveedor un bloque parcial.
  cost_types {
    include_credit             = false
    include_refund             = false
    include_discount           = true
    include_other_subscription = true
    include_recurring          = true
    include_subscription       = true
    include_support            = true
    include_tax                = true
    include_upfront            = true
    use_amortized              = false
    use_blended                = false
  }

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
