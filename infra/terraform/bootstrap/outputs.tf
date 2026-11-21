output "state_bucket" {
  description = "Bucket del state (backend.hcl: bucket)."
  value       = aws_s3_bucket.state.bucket
}

output "state_kms_key_arn" {
  description = "Clave KMS del state (backend.hcl: kms_key_id)."
  value       = aws_kms_key.state.arn
}
