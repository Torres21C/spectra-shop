variable "identifier" {
  description = "Identificador de la instancia RDS."
  type        = string
}

variable "engine_version" {
  description = "Versión de PostgreSQL (mayor, p. ej. \"16\", o mayor.menor)."
  type        = string
}

variable "instance_class" {
  description = "Clase de instancia."
  type        = string
}

variable "db_name" {
  description = "Nombre de la base (el maestro es su propietario, requisito de ADR-AWS-01)."
  type        = string
}

variable "master_username" {
  description = "Usuario maestro (no superusuario; miembro de rds_superuser)."
  type        = string
}

variable "allocated_storage_gb" {
  description = "Almacenamiento inicial (GB)."
  type        = number
}

variable "max_allocated_storage_gb" {
  description = "Tope del autoescalado de almacenamiento (GB); igual a allocated_storage_gb lo desactiva."
  type        = number
}

variable "subnet_ids" {
  description = "Subredes privadas de datos."
  type        = list(string)
}

variable "rds_sg_id" {
  description = "Security group de RDS."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK de datos (almacenamiento, secreto del maestro y log groups)."
  type        = string
}

variable "ca_cert_identifier" {
  description = "Autoridad de certificación del servidor RDS."
  type        = string
}

variable "backup_retention_days" {
  description = "Retención de copias automáticas (días)."
  type        = number
}

variable "deletion_protection" {
  description = "Protección contra borrado (hay que desactivarla expresamente antes de destruir)."
  type        = bool
}

variable "skip_final_snapshot" {
  description = "Omite el snapshot final al destruir (requiere autorización expresa del propietario)."
  type        = bool
}

variable "final_snapshot_identifier" {
  description = "Nombre del snapshot final (debe ser único en la cuenta)."
  type        = string
}

variable "apply_immediately" {
  description = "Aplica los cambios de la instancia de inmediato en lugar de en la ventana de mantenimiento."
  type        = bool
}

variable "log_retention_days" {
  description = "Retención de los logs exportados de PostgreSQL."
  type        = number
}
