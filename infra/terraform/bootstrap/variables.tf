variable "aws_region" {
  description = "Región del bucket del state."
  type        = string
  default     = "us-east-1"
}

variable "noncurrent_version_days" {
  description = "Días que se conservan las versiones anteriores del state."
  type        = number
  default     = 90
}

variable "state_admin_role_arns" {
  description = "ARN de los roles (Identity Center, CI de PR-6) autorizados a leer y escribir el state. Vacío = solo IAM de la cuenta."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------------------------------------
# PR-6.2: auditoría del state (R-PR5-26) y presupuesto de la cuenta (D7)
# ---------------------------------------------------------------------------------------------------------

variable "audit_log_retention_days" {
  description = "Días que se conservan los registros de acceso al state (versión actual y anteriores). D8: 365."
  type        = number
  default     = 365

  validation {
    condition     = var.audit_log_retention_days >= 365 && floor(var.audit_log_retention_days) == var.audit_log_retention_days
    error_message = "La retención de los registros de auditoría del state es de al menos 365 días (D8)."
  }
}

variable "budget_limit_usd" {
  description = "Límite mensual del presupuesto de la cuenta, en USD. Es un umbral de aviso, no un tope de gasto."
  type        = number
  default     = 50

  validation {
    condition     = var.budget_limit_usd > 0
    error_message = "budget_limit_usd debe ser mayor que 0."
  }
}

variable "budget_alert_percentages" {
  description = "Porcentajes del límite que generan aviso por gasto real (además del 100 % del pronóstico)."
  type        = list(number)
  default     = [50, 100]

  validation {
    condition     = length(var.budget_alert_percentages) > 0 && alltrue([for p in var.budget_alert_percentages : p > 0 && p <= 1000])
    error_message = "budget_alert_percentages: al menos un porcentaje, cada uno entre 0 y 1000."
  }
}

variable "budget_emails" {
  description = "Destinatarios de los avisos del presupuesto (no se versionan: van en terraform.tfvars). Obligatorio: el bootstrap no crea recursos facturables sin presupuesto (D7)."
  type        = list(string)

  validation {
    condition     = length(var.budget_emails) > 0 && alltrue([for e in var.budget_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$", e))])
    error_message = "budget_emails: al menos un correo válido. El presupuesto debe existir antes del primer recurso facturable (D7)."
  }
}
