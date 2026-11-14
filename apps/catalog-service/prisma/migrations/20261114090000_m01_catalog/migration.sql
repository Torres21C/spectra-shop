CREATE SCHEMA IF NOT EXISTS "catalog";

CREATE TABLE "catalog"."categories" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "catalog"."products" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "search_text" VARCHAR(2200) NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "stock" INTEGER NOT NULL,
    "image_key" VARCHAR(64) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "products_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "products_price_positive" CHECK ("price" > 0),
    CONSTRAINT "products_stock_nonnegative" CHECK ("stock" >= 0)
);

CREATE UNIQUE INDEX "categories_slug_key" ON "catalog"."categories"("slug");
CREATE UNIQUE INDEX "categories_name_key" ON "catalog"."categories"("name");
CREATE INDEX "categories_is_active_idx" ON "catalog"."categories"("is_active");
CREATE UNIQUE INDEX "products_sku_key" ON "catalog"."products"("sku");
CREATE INDEX "products_category_id_idx" ON "catalog"."products"("category_id");
CREATE INDEX "products_is_active_name_idx" ON "catalog"."products"("is_active", "name");
CREATE INDEX "products_search_text_idx" ON "catalog"."products"("search_text");

ALTER TABLE "catalog"."products"
ADD CONSTRAINT "products_category_id_fkey"
FOREIGN KEY ("category_id") REFERENCES "catalog"."categories"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
