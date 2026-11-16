import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class AddCartItemDto {
  @IsUUID('4')
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}

export class UpdateCartItemDto {
  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}

export class CartItemIdDto {
  @IsUUID('4')
  itemId!: string;
}
