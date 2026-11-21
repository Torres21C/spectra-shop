output "endpoint_ids" {
  description = "IDs de los interface endpoints por servicio."
  value       = { for name, ep in aws_vpc_endpoint.interface : name => ep.id }
}
