output "distribution_id" {
  description = "ID de la distribución (invalidaciones de PR-6)."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "ARN de la distribución."
  value       = aws_cloudfront_distribution.this.arn
}

output "cloudfront_domain_name" {
  description = "Dominio *.cloudfront.net."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "public_origin" {
  description = "Origen público https://<dominio> (CORS_ORIGINS y VITE_*_API_URL)."
  value       = "https://${coalesce(var.domain_name, aws_cloudfront_distribution.this.domain_name)}"
}

output "spa_bucket_name" {
  description = "Bucket de la SPA."
  value       = aws_s3_bucket.spa.bucket
}

output "spa_bucket_arn" {
  description = "ARN del bucket de la SPA."
  value       = aws_s3_bucket.spa.arn
}

output "web_acl_arn" {
  description = "ARN de la Web ACL."
  value       = aws_wafv2_web_acl.this.arn
}

output "vpc_origin_id" {
  description = "ID del VPC origin."
  value       = aws_cloudfront_vpc_origin.alb.id
}

output "waf_log_group_name" {
  description = "Log group de WAF."
  value       = aws_cloudwatch_log_group.waf.name
}

output "spa_kms_key_arn" {
  description = "CMK del bucket de la SPA (PR-6: el rol de despliegue necesita kms:GenerateDataKey para s3 sync)."
  value       = aws_kms_key.spa.arn
}
