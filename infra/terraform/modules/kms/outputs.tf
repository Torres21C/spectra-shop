output "data_key_arn" {
  description = "ARN de la CMK de datos."
  value       = aws_kms_key.data.arn
}

output "jwt_key_arn" {
  description = "ARN de la clave asimétrica de firma de JWT."
  value       = aws_kms_key.jwt.arn
}

output "jwt_key_alias" {
  description = "Alias de la clave de firma de JWT."
  value       = aws_kms_alias.jwt.name
}

output "jwt_public_key_pem" {
  description = "Clave pública PEM (SPKI) de la clave de firma; no es secreta."
  value       = data.aws_kms_public_key.jwt.public_key_pem
}
