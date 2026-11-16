import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

const NAME_PATTERN = /^[\p{L}][\p{L}\p{M} '-]{0,78}[\p{L}\p{M}]$/u;

export class RegisterDto {
  @ApiProperty({ example: 'Ana Torres', minLength: 2, maxLength: 80 })
  @IsString()
  @Length(2, 80)
  @Matches(NAME_PATTERN)
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.trim() : value))
  fullName!: string;

  @ApiProperty({ example: 'ana.synthetic@example.test', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ minLength: 12, maxLength: 128, writeOnly: true })
  @IsString()
  @Length(12, 128)
  password!: string;

  @ApiProperty({ minLength: 12, maxLength: 128, writeOnly: true })
  @IsString()
  @Length(12, 128)
  passwordConfirmation!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  academicDataAccepted!: boolean;
}

export class LoginDto {
  @ApiProperty({ example: 'ana.synthetic@example.test', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ maxLength: 128, writeOnly: true })
  @IsString()
  @Length(1, 128)
  password!: string;

  @ApiPropertyOptional({ example: '#/pedidos', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  returnTo?: string;
}

export class ProfileQueryDto {}
