variable "enabled" {
  description = "Crea el rol publicador (y, si procede, el proveedor OIDC). Desactivado por defecto hasta la autorización del propietario."
  type        = bool
  default     = false
}

variable "name_prefix" {
  description = "Prefijo de nombres (spectra-<entorno>)."
  type        = string
}

variable "create_oidc_provider" {
  description = "true: crea el proveedor OIDC de GitHub de la cuenta. false: usa el ya existente, leído por su URL (data source) y validado (audiencia sts.amazonaws.com); no lo importa ni lo administra. AWS solo admite uno por URL y cuenta."
  type        = bool
  default     = true
}

variable "oidc_subject_prefix" {
  description = "Prefijo inmutable del claim sub del repositorio (repo:OWNER@OWNER_ID/REPO@REPO_ID), consultable en GET /repos/{owner}/{repo}/actions/oidc/customization/sub."
  type        = string

  validation {
    condition     = can(regex("^repo:[A-Za-z0-9][A-Za-z0-9-]{0,38}@[0-9]+/[A-Za-z0-9._-]{1,100}@[0-9]+$", var.oidc_subject_prefix))
    error_message = "oidc_subject_prefix debe tener el formato inmutable repo:OWNER@ID/REPO@ID, sin comodines."
  }
}

variable "github_environment" {
  description = "GitHub Environment autorizado (con aprobación humana y restringido a main). Es el único contexto que puede asumir el rol."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,255}$", var.github_environment))
    error_message = "github_environment solo admite letras, dígitos, punto, guion y guion bajo (sin comodines ni dos puntos)."
  }
}

variable "repository_arns" {
  description = "ARN de los repositorios ECR en los que se puede publicar (salida repository_arns del módulo registry)."
  type        = map(string)

  validation {
    condition     = length(var.repository_arns) > 0 && alltrue([for arn in values(var.repository_arns) : can(regex("^arn:aws:ecr:[a-z0-9-]+:[0-9]{12}:repository/[a-z0-9._/-]+$", arn))])
    error_message = "repository_arns debe contener ARN concretos de repositorios ECR, sin comodines."
  }
}

variable "permissions_boundary_arn" {
  description = "Límite de permisos opcional para el rol."
  type        = string
  default     = null
}
