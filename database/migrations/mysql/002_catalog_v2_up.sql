-- Catalog V2 migration for MySQL 8.0+
-- Source: src/server/db/catalog-v2-migration.mjs (SQLite migration v2)
-- Preconditions:
--   * Existing operational tables already exist: staff_users, service_plans,
--     stock_items, promotions.
--   * Foreign-key ID columns in those tables use signed BIGINT.
--   * The application/session stores DATETIME values in UTC.
--
-- This migration is additive. It does not alter or remove legacy tables.

CREATE TABLE catalog_categories (
  id BIGINT NOT NULL AUTO_INCREMENT,
  parent_id BIGINT NULL,
  category_code VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  slug VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  category_name VARCHAR(120) NOT NULL,
  description VARCHAR(1000) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by_staff_user_id BIGINT NULL,
  updated_by_staff_user_id BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  row_version INT NOT NULL DEFAULT 1,

  CONSTRAINT pk_catalog_categories PRIMARY KEY (id),
  CONSTRAINT uq_catalog_categories_code UNIQUE (category_code),
  CONSTRAINT uq_catalog_categories_slug UNIQUE (slug),
  CONSTRAINT chk_catalog_categories_code
    CHECK (CHAR_LENGTH(TRIM(category_code)) BETWEEN 1 AND 50),
  CONSTRAINT chk_catalog_categories_slug
    CHECK (
      CHAR_LENGTH(slug) BETWEEN 1 AND 100
      AND slug = LOWER(slug)
      AND INSTR(slug, ' ') = 0
    ),
  CONSTRAINT chk_catalog_categories_name
    CHECK (CHAR_LENGTH(TRIM(category_name)) BETWEEN 1 AND 120),
  CONSTRAINT chk_catalog_categories_description
    CHECK (description IS NULL OR CHAR_LENGTH(description) <= 1000),
  CONSTRAINT chk_catalog_categories_sort_order CHECK (sort_order >= 0),
  CONSTRAINT chk_catalog_categories_active CHECK (is_active IN (0, 1)),
  CONSTRAINT chk_catalog_categories_row_version CHECK (row_version >= 1),
  CONSTRAINT fk_catalog_categories_parent
    FOREIGN KEY (parent_id)
    REFERENCES catalog_categories(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_categories_created_by
    FOREIGN KEY (created_by_staff_user_id)
    REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_catalog_categories_updated_by
    FOREIGN KEY (updated_by_staff_user_id)
    REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE SET NULL,

  INDEX idx_catalog_categories_parent_sort (parent_id, sort_order, id),
  INDEX idx_catalog_categories_active_sort (is_active, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE catalog_products (
  id BIGINT NOT NULL AUTO_INCREMENT,
  product_code VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  slug VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_name VARCHAR(200) NOT NULL,
  product_type VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_plan_id BIGINT NULL,
  stock_item_id BIGINT NULL,
  status VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DRAFT',
  sort_order INT NOT NULL DEFAULT 0,
  is_featured TINYINT(1) NOT NULL DEFAULT 0,
  publish_from DATETIME NULL,
  publish_until DATETIME NULL,
  created_by_staff_user_id BIGINT NULL,
  updated_by_staff_user_id BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  row_version INT NOT NULL DEFAULT 1,

  CONSTRAINT pk_catalog_products PRIMARY KEY (id),
  CONSTRAINT uq_catalog_products_code UNIQUE (product_code),
  CONSTRAINT uq_catalog_products_slug UNIQUE (slug),
  CONSTRAINT uq_catalog_products_service_plan UNIQUE (service_plan_id),
  CONSTRAINT uq_catalog_products_stock_item UNIQUE (stock_item_id),
  CONSTRAINT chk_catalog_products_code
    CHECK (CHAR_LENGTH(TRIM(product_code)) BETWEEN 1 AND 50),
  CONSTRAINT chk_catalog_products_slug
    CHECK (
      CHAR_LENGTH(slug) BETWEEN 1 AND 120
      AND slug = LOWER(slug)
      AND INSTR(slug, ' ') = 0
    ),
  CONSTRAINT chk_catalog_products_name
    CHECK (CHAR_LENGTH(TRIM(product_name)) BETWEEN 1 AND 200),
  CONSTRAINT chk_catalog_products_type
    CHECK (product_type IN ('SERVICE_PLAN', 'STOCK_ITEM', 'GENERAL')),
  CONSTRAINT chk_catalog_products_status
    CHECK (status IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED')),
  CONSTRAINT chk_catalog_products_sort_order CHECK (sort_order >= 0),
  CONSTRAINT chk_catalog_products_featured CHECK (is_featured IN (0, 1)),
  CONSTRAINT chk_catalog_products_row_version CHECK (row_version >= 1),
  CONSTRAINT chk_catalog_products_source
    CHECK (
      (
        product_type = 'SERVICE_PLAN'
        AND service_plan_id IS NOT NULL
        AND stock_item_id IS NULL
      )
      OR (
        product_type = 'STOCK_ITEM'
        AND service_plan_id IS NULL
        AND stock_item_id IS NOT NULL
      )
      OR (
        product_type = 'GENERAL'
        AND service_plan_id IS NULL
        AND stock_item_id IS NULL
      )
    ),
  CONSTRAINT chk_catalog_products_schedule
    CHECK (status <> 'SCHEDULED' OR publish_from IS NOT NULL),
  CONSTRAINT chk_catalog_products_publish_window
    CHECK (
      publish_from IS NULL
      OR publish_until IS NULL
      OR publish_from < publish_until
    ),
  CONSTRAINT fk_catalog_products_service_plan
    FOREIGN KEY (service_plan_id)
    REFERENCES service_plans(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_products_stock_item
    FOREIGN KEY (stock_item_id)
    REFERENCES stock_items(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_products_created_by
    FOREIGN KEY (created_by_staff_user_id)
    REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_catalog_products_updated_by
    FOREIGN KEY (updated_by_staff_user_id)
    REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE SET NULL,

  INDEX idx_catalog_products_publication
    (status, publish_from, publish_until, sort_order, id),
  INDEX idx_catalog_products_type_sort (product_type, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE catalog_product_categories (
  product_id BIGINT NOT NULL,
  category_id BIGINT NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT pk_catalog_product_categories PRIMARY KEY (product_id, category_id),
  CONSTRAINT chk_catalog_product_categories_primary CHECK (is_primary IN (0, 1)),
  CONSTRAINT chk_catalog_product_categories_sort_order CHECK (sort_order >= 0),
  CONSTRAINT fk_catalog_product_categories_product
    FOREIGN KEY (product_id)
    REFERENCES catalog_products(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_catalog_product_categories_category
    FOREIGN KEY (category_id)
    REFERENCES catalog_categories(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  INDEX idx_catalog_product_categories_category
    (category_id, sort_order, product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SQLite used a partial unique index WHERE is_primary = 1.
-- MySQL 8 functional key parts preserve the same rule because NULL values do
-- not conflict in UNIQUE indexes.
CREATE UNIQUE INDEX uq_catalog_product_categories_primary
  ON catalog_product_categories (
    (CASE WHEN is_primary = 1 THEN product_id ELSE NULL END)
  );

CREATE TABLE catalog_product_content (
  id BIGINT NOT NULL AUTO_INCREMENT,
  product_id BIGINT NOT NULL,
  locale VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(200) NOT NULL,
  summary VARCHAR(500) NULL,
  body_text TEXT NULL,
  seo_title VARCHAR(70) NULL,
  seo_description VARCHAR(160) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  row_version INT NOT NULL DEFAULT 1,

  CONSTRAINT pk_catalog_product_content PRIMARY KEY (id),
  CONSTRAINT uq_catalog_product_content_product_locale UNIQUE (product_id, locale),
  CONSTRAINT chk_catalog_product_content_locale
    CHECK (CHAR_LENGTH(locale) BETWEEN 2 AND 10 AND INSTR(locale, ' ') = 0),
  CONSTRAINT chk_catalog_product_content_title
    CHECK (CHAR_LENGTH(TRIM(title)) BETWEEN 1 AND 200),
  CONSTRAINT chk_catalog_product_content_summary
    CHECK (summary IS NULL OR CHAR_LENGTH(summary) <= 500),
  CONSTRAINT chk_catalog_product_content_body
    CHECK (body_text IS NULL OR CHAR_LENGTH(body_text) <= 20000),
  CONSTRAINT chk_catalog_product_content_seo_title
    CHECK (seo_title IS NULL OR CHAR_LENGTH(seo_title) <= 70),
  CONSTRAINT chk_catalog_product_content_seo_description
    CHECK (seo_description IS NULL OR CHAR_LENGTH(seo_description) <= 160),
  CONSTRAINT chk_catalog_product_content_row_version CHECK (row_version >= 1),
  CONSTRAINT fk_catalog_product_content_product
    FOREIGN KEY (product_id)
    REFERENCES catalog_products(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,

  INDEX idx_catalog_product_content_locale (locale, product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE catalog_product_sections (
  id BIGINT NOT NULL AUTO_INCREMENT,
  product_id BIGINT NOT NULL,
  locale VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  section_key VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  section_type VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'TEXT',
  title VARCHAR(200) NULL,
  body_text TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  row_version INT NOT NULL DEFAULT 1,

  CONSTRAINT pk_catalog_product_sections PRIMARY KEY (id),
  CONSTRAINT uq_catalog_product_sections_key UNIQUE (product_id, locale, section_key),
  CONSTRAINT chk_catalog_product_sections_key
    CHECK (CHAR_LENGTH(TRIM(section_key)) BETWEEN 1 AND 80),
  CONSTRAINT chk_catalog_product_sections_type
    CHECK (section_type IN ('TEXT', 'FEATURE_LIST', 'NOTICE')),
  CONSTRAINT chk_catalog_product_sections_title
    CHECK (title IS NULL OR CHAR_LENGTH(title) <= 200),
  CONSTRAINT chk_catalog_product_sections_body
    CHECK (CHAR_LENGTH(body_text) BETWEEN 1 AND 10000),
  CONSTRAINT chk_catalog_product_sections_sort_order CHECK (sort_order >= 0),
  CONSTRAINT chk_catalog_product_sections_active CHECK (is_active IN (0, 1)),
  CONSTRAINT chk_catalog_product_sections_row_version CHECK (row_version >= 1),
  CONSTRAINT fk_catalog_product_sections_content
    FOREIGN KEY (product_id, locale)
    REFERENCES catalog_product_content(product_id, locale)
    ON UPDATE RESTRICT ON DELETE CASCADE,

  INDEX idx_catalog_product_sections_product_sort
    (product_id, locale, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE catalog_product_media (
  id BIGINT NOT NULL AUTO_INCREMENT,
  product_id BIGINT NOT NULL,
  media_type VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'IMAGE',
  media_usage VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'GALLERY',
  url VARCHAR(500) NOT NULL,
  alt_text VARCHAR(250) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  row_version INT NOT NULL DEFAULT 1,

  CONSTRAINT pk_catalog_product_media PRIMARY KEY (id),
  CONSTRAINT chk_catalog_product_media_type CHECK (media_type = 'IMAGE'),
  CONSTRAINT chk_catalog_product_media_usage
    CHECK (media_usage IN ('PRIMARY', 'GALLERY', 'ICON', 'BANNER')),
  CONSTRAINT chk_catalog_product_media_url
    CHECK (
      CHAR_LENGTH(url) BETWEEN 1 AND 500
      AND (
        (LEFT(url, 1) = '/' AND LEFT(url, 2) <> '//')
        OR LOWER(LEFT(url, 8)) = 'https://'
      )
    ),
  CONSTRAINT chk_catalog_product_media_alt
    CHECK (CHAR_LENGTH(TRIM(alt_text)) BETWEEN 1 AND 250),
  CONSTRAINT chk_catalog_product_media_primary CHECK (is_primary IN (0, 1)),
  CONSTRAINT chk_catalog_product_media_sort_order CHECK (sort_order >= 0),
  CONSTRAINT chk_catalog_product_media_row_version CHECK (row_version >= 1),
  CONSTRAINT chk_catalog_product_media_primary_usage
    CHECK (
      (is_primary = 1 AND media_usage = 'PRIMARY')
      OR (is_primary = 0 AND media_usage <> 'PRIMARY')
    ),
  CONSTRAINT fk_catalog_product_media_product
    FOREIGN KEY (product_id)
    REFERENCES catalog_products(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,

  INDEX idx_catalog_product_media_product_sort (product_id, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE UNIQUE INDEX uq_catalog_product_media_primary
  ON catalog_product_media (
    (CASE WHEN is_primary = 1 THEN product_id ELSE NULL END)
  );

CREATE TABLE catalog_product_specs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  product_id BIGINT NOT NULL,
  locale VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  spec_key VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  group_key VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  group_label VARCHAR(120) NOT NULL,
  spec_label VARCHAR(120) NOT NULL,
  spec_value VARCHAR(500) NOT NULL,
  unit VARCHAR(30) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  row_version INT NOT NULL DEFAULT 1,

  CONSTRAINT pk_catalog_product_specs PRIMARY KEY (id),
  CONSTRAINT uq_catalog_product_specs_key UNIQUE (product_id, spec_key, locale),
  CONSTRAINT chk_catalog_product_specs_key
    CHECK (CHAR_LENGTH(TRIM(spec_key)) BETWEEN 1 AND 80),
  CONSTRAINT chk_catalog_product_specs_group_key
    CHECK (CHAR_LENGTH(TRIM(group_key)) BETWEEN 1 AND 80),
  CONSTRAINT chk_catalog_product_specs_group_label
    CHECK (CHAR_LENGTH(TRIM(group_label)) BETWEEN 1 AND 120),
  CONSTRAINT chk_catalog_product_specs_label
    CHECK (CHAR_LENGTH(TRIM(spec_label)) BETWEEN 1 AND 120),
  CONSTRAINT chk_catalog_product_specs_value
    CHECK (CHAR_LENGTH(TRIM(spec_value)) BETWEEN 1 AND 500),
  CONSTRAINT chk_catalog_product_specs_unit
    CHECK (unit IS NULL OR CHAR_LENGTH(unit) <= 30),
  CONSTRAINT chk_catalog_product_specs_sort_order CHECK (sort_order >= 0),
  CONSTRAINT chk_catalog_product_specs_row_version CHECK (row_version >= 1),
  CONSTRAINT fk_catalog_product_specs_content
    FOREIGN KEY (product_id, locale)
    REFERENCES catalog_product_content(product_id, locale)
    ON UPDATE RESTRICT ON DELETE CASCADE,

  INDEX idx_catalog_product_specs_group_sort
    (product_id, locale, group_key, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE catalog_brands (
  id BIGINT NOT NULL AUTO_INCREMENT,
  brand_code VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  slug VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  brand_name VARCHAR(120) NOT NULL,
  description VARCHAR(1000) NULL,
  website_url VARCHAR(500) NULL,
  logo_url VARCHAR(500) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  row_version INT NOT NULL DEFAULT 1,

  CONSTRAINT pk_catalog_brands PRIMARY KEY (id),
  CONSTRAINT uq_catalog_brands_code UNIQUE (brand_code),
  CONSTRAINT uq_catalog_brands_slug UNIQUE (slug),
  CONSTRAINT chk_catalog_brands_code
    CHECK (CHAR_LENGTH(TRIM(brand_code)) BETWEEN 1 AND 50),
  CONSTRAINT chk_catalog_brands_slug
    CHECK (
      CHAR_LENGTH(slug) BETWEEN 1 AND 100
      AND slug = LOWER(slug)
      AND INSTR(slug, ' ') = 0
    ),
  CONSTRAINT chk_catalog_brands_name
    CHECK (CHAR_LENGTH(TRIM(brand_name)) BETWEEN 1 AND 120),
  CONSTRAINT chk_catalog_brands_description
    CHECK (description IS NULL OR CHAR_LENGTH(description) <= 1000),
  CONSTRAINT chk_catalog_brands_website_url
    CHECK (
      website_url IS NULL
      OR (
        CHAR_LENGTH(website_url) <= 500
        AND LOWER(LEFT(website_url, 8)) = 'https://'
      )
    ),
  CONSTRAINT chk_catalog_brands_logo_url
    CHECK (
      logo_url IS NULL
      OR (
        CHAR_LENGTH(logo_url) <= 500
        AND (
          (LEFT(logo_url, 1) = '/' AND LEFT(logo_url, 2) <> '//')
          OR LOWER(LEFT(logo_url, 8)) = 'https://'
        )
      )
    ),
  CONSTRAINT chk_catalog_brands_sort_order CHECK (sort_order >= 0),
  CONSTRAINT chk_catalog_brands_active CHECK (is_active IN (0, 1)),
  CONSTRAINT chk_catalog_brands_row_version CHECK (row_version >= 1),

  INDEX idx_catalog_brands_active_sort (is_active, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE catalog_product_brands (
  product_id BIGINT NOT NULL,
  brand_id BIGINT NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT pk_catalog_product_brands PRIMARY KEY (product_id, brand_id),
  CONSTRAINT chk_catalog_product_brands_primary CHECK (is_primary IN (0, 1)),
  CONSTRAINT chk_catalog_product_brands_sort_order CHECK (sort_order >= 0),
  CONSTRAINT fk_catalog_product_brands_product
    FOREIGN KEY (product_id)
    REFERENCES catalog_products(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_catalog_product_brands_brand
    FOREIGN KEY (brand_id)
    REFERENCES catalog_brands(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  INDEX idx_catalog_product_brands_brand (brand_id, sort_order, product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE UNIQUE INDEX uq_catalog_product_brands_primary
  ON catalog_product_brands (
    (CASE WHEN is_primary = 1 THEN product_id ELSE NULL END)
  );

CREATE TABLE catalog_promotion_products (
  promotion_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT pk_catalog_promotion_products PRIMARY KEY (promotion_id, product_id),
  CONSTRAINT fk_catalog_promotion_products_promotion
    FOREIGN KEY (promotion_id)
    REFERENCES promotions(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_catalog_promotion_products_product
    FOREIGN KEY (product_id)
    REFERENCES catalog_products(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,

  INDEX idx_catalog_promotion_products_product (product_id, promotion_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- MySQL equivalents of the SQLite category-depth/cycle triggers.
DELIMITER $$

CREATE TRIGGER trg_catalog_categories_insert_depth
BEFORE INSERT ON catalog_categories
FOR EACH ROW
BEGIN
  DECLARE v_parent_depth INT DEFAULT 0;

  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.id IS NOT NULL AND NEW.parent_id = NEW.id THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'catalog category cycle is not allowed';
    END IF;

    WITH RECURSIVE ancestors (id, parent_id, level) AS (
      SELECT id, parent_id, 1
      FROM catalog_categories
      WHERE id = NEW.parent_id

      UNION ALL

      SELECT category.id, category.parent_id, ancestors.level + 1
      FROM catalog_categories AS category
      JOIN ancestors ON category.id = ancestors.parent_id
      WHERE ancestors.parent_id IS NOT NULL
    )
    SELECT COALESCE(MAX(level), 0)
      INTO v_parent_depth
    FROM ancestors;

    IF v_parent_depth >= 4 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'catalog category maximum depth is 4';
    END IF;
  END IF;
END$$

CREATE TRIGGER trg_catalog_categories_update_parent
BEFORE UPDATE ON catalog_categories
FOR EACH ROW
BEGIN
  DECLARE v_is_descendant INT DEFAULT 0;
  DECLARE v_parent_depth INT DEFAULT 0;
  DECLARE v_subtree_depth INT DEFAULT 1;

  IF NOT (NEW.parent_id <=> OLD.parent_id) THEN
    IF NEW.parent_id = OLD.id THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'catalog category cycle is not allowed';
    END IF;

    IF NEW.parent_id IS NOT NULL THEN
      WITH RECURSIVE descendants (id) AS (
        SELECT OLD.id

        UNION ALL

        SELECT category.id
        FROM catalog_categories AS category
        JOIN descendants ON category.parent_id = descendants.id
      )
      SELECT COUNT(*)
        INTO v_is_descendant
      FROM descendants
      WHERE id = NEW.parent_id;

      IF v_is_descendant > 0 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'catalog category cycle is not allowed';
      END IF;

      WITH RECURSIVE ancestors (id, parent_id, level) AS (
        SELECT id, parent_id, 1
        FROM catalog_categories
        WHERE id = NEW.parent_id

        UNION ALL

        SELECT category.id, category.parent_id, ancestors.level + 1
        FROM catalog_categories AS category
        JOIN ancestors ON category.id = ancestors.parent_id
        WHERE ancestors.parent_id IS NOT NULL
      )
      SELECT COALESCE(MAX(level), 0)
        INTO v_parent_depth
      FROM ancestors;
    END IF;

    WITH RECURSIVE subtree (id, level) AS (
      SELECT OLD.id, 1

      UNION ALL

      SELECT category.id, subtree.level + 1
      FROM catalog_categories AS category
      JOIN subtree ON category.parent_id = subtree.id
    )
    SELECT COALESCE(MAX(level), 1)
      INTO v_subtree_depth
    FROM subtree;

    IF v_parent_depth + v_subtree_depth > 4 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'catalog category maximum depth is 4';
    END IF;
  END IF;
END$$

DELIMITER ;
