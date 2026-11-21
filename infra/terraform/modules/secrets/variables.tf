variable "secret_prefix" {
  description = "Prefijo de los nombres de los secretos (p. ej. spectra/lab)."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK de datos con la que se cifran los secretos."
  type        = string
}

variable "recovery_window_days" {
  description = "Ventana de recuperación al borrar (0 = borrado inmediato; 7-30)."
  type        = number
}

variable "db_address" {
  description = "Nombre DNS privado de RDS (para la URL)."
  type        = string
}

variable "db_port" {
  description = "Puerto de PostgreSQL."
  type        = number
}

variable "db_name" {
  description = "Nombre de la base."
  type        = string
}

variable "connection_limit" {
  description = "connection_limit de Prisma en cada URL (AWS-22)."
  type        = number
}

variable "synthetic_admin_email" {
  description = "Correo ficticio del ADMIN sintético; null para no crearlo."
  type        = string
  default     = null
}

variable "secret_versions" {
  description = "Versión write-only por secreto (claves db/<servicio>-<rol>, internal-token, inventory-token, synthetic-admin). Incrementar = regenerar y reescribir el valor."
  type        = map(number)
}
