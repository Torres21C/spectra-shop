variable "name_prefix" {
  description = "Prefijo de nombres de recursos."
  type        = string
}

variable "region" {
  description = "Región AWS."
  type        = string
}

variable "account_id" {
  description = "ID de la cuenta AWS."
  type        = string
}

variable "deletion_window_days" {
  description = "Ventana de borrado programado de las claves (7-30 días)."
  type        = number

  validation {
    condition     = var.deletion_window_days >= 7 && var.deletion_window_days <= 30
    error_message = "deletion_window_days debe estar entre 7 y 30."
  }
}
