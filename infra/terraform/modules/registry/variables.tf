variable "repository_prefix" {
  description = "Prefijo de los repositorios (plan §10: spectra)."
  type        = string
}

variable "repositories" {
  description = "Repositorios a crear."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "CMK de datos."
  type        = string
}

variable "force_delete" {
  description = "Permite borrar repositorios con imágenes al destruir."
  type        = bool
}

variable "keep_images" {
  description = "Imágenes etiquetadas que se conservan por repositorio."
  type        = number
}
