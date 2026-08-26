-- Rollback for Catalog V2 MySQL migration v2.
-- This removes only Catalog V2 objects and leaves all legacy operational tables intact.

DROP TRIGGER IF EXISTS trg_catalog_categories_update_parent;
DROP TRIGGER IF EXISTS trg_catalog_categories_insert_depth;

DROP TABLE IF EXISTS catalog_promotion_products;
DROP TABLE IF EXISTS catalog_product_brands;
DROP TABLE IF EXISTS catalog_product_categories;
DROP TABLE IF EXISTS catalog_product_specs;
DROP TABLE IF EXISTS catalog_product_media;
DROP TABLE IF EXISTS catalog_product_sections;
DROP TABLE IF EXISTS catalog_product_content;
DROP TABLE IF EXISTS catalog_products;
DROP TABLE IF EXISTS catalog_brands;
DROP TABLE IF EXISTS catalog_categories;
