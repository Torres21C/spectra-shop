output "vpc_id" {
  description = "ID de la VPC."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "CIDR de la VPC."
  value       = aws_vpc.this.cidr_block
}

output "app_subnet_ids" {
  description = "IDs de las subredes de aplicación, en el orden de az_ids."
  value       = [for az_id in var.az_ids : aws_subnet.app[az_id].id]
}

output "data_subnet_ids" {
  description = "IDs de las subredes de datos, en el orden de az_ids."
  value       = [for az_id in var.az_ids : aws_subnet.data[az_id].id]
}

output "app_route_table_id" {
  description = "Tabla de rutas de aplicación (sin rutas públicas)."
  value       = aws_route_table.app.id
}

output "s3_prefix_list_id" {
  description = "Prefix list de S3 del gateway endpoint (reglas de salida de los security groups)."
  value       = aws_vpc_endpoint.s3.prefix_list_id
}

output "internet_gateway_id" {
  description = "IGW asociado solo como requisito de CloudFront VPC origins (sin rutas)."
  value       = aws_internet_gateway.this.id
}
