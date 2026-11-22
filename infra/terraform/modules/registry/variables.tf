variable "repository_prefix" {
  description = "Prefijo de los repositorios (plan §10: spectra)."
  type        = string
}

variable "repositories" {
  description = "Repositorios a crear."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "CMK propia para cifrar los repositorios. null (por defecto) = clave administrada por AWS aws/ecr (D2 de PR-6.2)."
  type        = string
  default     = null

  validation {
    condition     = var.kms_key_arn == null || can(regex("^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$", var.kms_key_arn))
    error_message = "kms_key_arn debe ser el ARN de una clave KMS concreta (no un alias) o null para usar aws/ecr."
  }
}

variable "force_delete" {
  description = "Permite borrar repositorios con imágenes al destruir."
  type        = bool
}

variable "keep_images" {
  description = "Imágenes etiquetadas que se conservan por repositorio."
  type        = number
}
