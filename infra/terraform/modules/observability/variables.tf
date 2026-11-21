variable "name_prefix" {
  description = "Prefijo de nombres de recursos."
  type        = string
}

variable "environment" {
  description = "Nombre del entorno."
  type        = string
}

variable "workloads" {
  description = "Cargas de trabajo con log group propio (servicios y tareas de operación)."
  type        = list(string)
}

variable "log_retention_days" {
  description = "Retención de los logs (días)."
  type        = number
}

variable "kms_key_arn" {
  description = "CMK de los log groups y del tema SNS."
  type        = string
}

variable "alarm_email" {
  description = "Correo para las alarmas (null = sin suscripción; la suscripción requiere confirmación)."
  type        = string
  default     = null
}

variable "alb_arn_suffix" {
  description = "Sufijo del ARN del ALB."
  type        = string
}

variable "target_group_arn_suffixes" {
  description = "Sufijo del ARN de cada target group por servicio."
  type        = map(string)
}

variable "alb_5xx_threshold" {
  description = "Respuestas 5xx en 5 minutos que disparan la alarma."
  type        = number
}

variable "db_identifier" {
  description = "Identificador de la instancia RDS."
  type        = string
}

variable "budget_limit_usd" {
  description = "Límite mensual del presupuesto (USD)."
  type        = number
}

variable "budget_alert_percentages" {
  description = "Porcentajes del límite que generan aviso (gasto real)."
  type        = list(number)
}

variable "budget_emails" {
  description = "Destinatarios del presupuesto (lista vacía = sin presupuesto)."
  type        = list(string)
}
