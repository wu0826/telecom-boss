export const CATALOG_V2_UP_SQL = `
  CREATE TABLE catalog_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER,
    category_code TEXT NOT NULL UNIQUE
      CHECK (length(trim(category_code)) BETWEEN 1 AND 50),
    slug TEXT NOT NULL UNIQUE
      CHECK (
        length(slug) BETWEEN 1 AND 100
        AND slug = lower(slug)
        AND instr(slug, ' ') = 0
      ),
    category_name TEXT NOT NULL
      CHECK (length(trim(category_name)) BETWEEN 1 AND 120),
    description TEXT CHECK (description IS NULL OR length(description) <= 1000),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_by_staff_user_id INTEGER,
    updated_by_staff_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    FOREIGN KEY (parent_id)
      REFERENCES catalog_categories(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (created_by_staff_user_id)
      REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
    FOREIGN KEY (updated_by_staff_user_id)
      REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE SET NULL
  ) STRICT;

  CREATE INDEX idx_catalog_categories_parent_sort
    ON catalog_categories(parent_id, sort_order, id);
  CREATE INDEX idx_catalog_categories_active_sort
    ON catalog_categories(is_active, sort_order, id);

  CREATE TRIGGER trg_catalog_categories_insert_depth
  BEFORE INSERT ON catalog_categories
  WHEN NEW.parent_id IS NOT NULL
  BEGIN
    SELECT CASE
      WHEN NEW.parent_id = NEW.id
      THEN RAISE(ABORT, 'catalog category cycle is not allowed')
    END;

    WITH RECURSIVE ancestors(id, parent_id, level) AS (
      SELECT id, parent_id, 1
      FROM catalog_categories
      WHERE id = NEW.parent_id
      UNION ALL
      SELECT category.id, category.parent_id, ancestors.level + 1
      FROM catalog_categories AS category
      JOIN ancestors ON category.id = ancestors.parent_id
      WHERE ancestors.parent_id IS NOT NULL
    )
    SELECT CASE
      WHEN COALESCE(MAX(level), 0) >= 4
      THEN RAISE(ABORT, 'catalog category maximum depth is 4')
    END
    FROM ancestors;
  END;

  CREATE TRIGGER trg_catalog_categories_update_parent
  BEFORE UPDATE OF parent_id ON catalog_categories
  WHEN NEW.parent_id IS NOT OLD.parent_id
  BEGIN
    SELECT CASE
      WHEN NEW.parent_id = OLD.id
      THEN RAISE(ABORT, 'catalog category cycle is not allowed')
    END;

    WITH RECURSIVE descendants(id) AS (
      SELECT OLD.id
      UNION ALL
      SELECT category.id
      FROM catalog_categories AS category
      JOIN descendants ON category.parent_id = descendants.id
    )
    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM descendants
        WHERE id = NEW.parent_id
      )
      THEN RAISE(ABORT, 'catalog category cycle is not allowed')
    END;

    WITH RECURSIVE
    ancestors(id, parent_id, level) AS (
      SELECT id, parent_id, 1
      FROM catalog_categories
      WHERE id = NEW.parent_id
      UNION ALL
      SELECT category.id, category.parent_id, ancestors.level + 1
      FROM catalog_categories AS category
      JOIN ancestors ON category.id = ancestors.parent_id
      WHERE ancestors.parent_id IS NOT NULL
    ),
    subtree(id, level) AS (
      SELECT OLD.id, 1
      UNION ALL
      SELECT category.id, subtree.level + 1
      FROM catalog_categories AS category
      JOIN subtree ON category.parent_id = subtree.id
    )
    SELECT CASE
      WHEN COALESCE((SELECT MAX(level) FROM ancestors), 0)
        + COALESCE((SELECT MAX(level) FROM subtree), 1) > 4
      THEN RAISE(ABORT, 'catalog category maximum depth is 4')
    END;
  END;

  CREATE TABLE catalog_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code TEXT NOT NULL UNIQUE
      CHECK (length(trim(product_code)) BETWEEN 1 AND 50),
    slug TEXT NOT NULL UNIQUE
      CHECK (
        length(slug) BETWEEN 1 AND 120
        AND slug = lower(slug)
        AND instr(slug, ' ') = 0
      ),
    product_name TEXT NOT NULL
      CHECK (length(trim(product_name)) BETWEEN 1 AND 200),
    product_type TEXT NOT NULL
      CHECK (product_type IN ('SERVICE_PLAN', 'STOCK_ITEM', 'GENERAL')),
    service_plan_id INTEGER UNIQUE,
    stock_item_id INTEGER UNIQUE,
    status TEXT NOT NULL DEFAULT 'DRAFT'
      CHECK (status IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED')),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
    publish_from TEXT
      CHECK (
        publish_from IS NULL
        OR (
          length(publish_from) BETWEEN 20 AND 30
          AND substr(publish_from, -1, 1) = 'Z'
          AND julianday(publish_from) IS NOT NULL
        )
      ),
    publish_until TEXT
      CHECK (
        publish_until IS NULL
        OR (
          length(publish_until) BETWEEN 20 AND 30
          AND substr(publish_until, -1, 1) = 'Z'
          AND julianday(publish_until) IS NOT NULL
        )
      ),
    created_by_staff_user_id INTEGER,
    updated_by_staff_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
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
    CHECK (status <> 'SCHEDULED' OR publish_from IS NOT NULL),
    CHECK (
      publish_from IS NULL
      OR publish_until IS NULL
      OR publish_from < publish_until
    ),
    FOREIGN KEY (service_plan_id)
      REFERENCES service_plans(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (stock_item_id)
      REFERENCES stock_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (created_by_staff_user_id)
      REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
    FOREIGN KEY (updated_by_staff_user_id)
      REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE SET NULL
  ) STRICT;

  CREATE INDEX idx_catalog_products_publication
    ON catalog_products(status, publish_from, publish_until, sort_order, id);
  CREATE INDEX idx_catalog_products_type_sort
    ON catalog_products(product_type, sort_order, id);

  CREATE TABLE catalog_product_categories (
    product_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (product_id, category_id),
    FOREIGN KEY (product_id)
      REFERENCES catalog_products(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    FOREIGN KEY (category_id)
      REFERENCES catalog_categories(id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT;

  CREATE UNIQUE INDEX uq_catalog_product_categories_primary
    ON catalog_product_categories(product_id)
    WHERE is_primary = 1;
  CREATE INDEX idx_catalog_product_categories_category
    ON catalog_product_categories(category_id, sort_order, product_id);

  CREATE TABLE catalog_product_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    locale TEXT NOT NULL
      CHECK (
        length(locale) BETWEEN 2 AND 10
        AND instr(locale, ' ') = 0
      ),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    summary TEXT CHECK (summary IS NULL OR length(summary) <= 500),
    body_text TEXT CHECK (body_text IS NULL OR length(body_text) <= 20000),
    seo_title TEXT CHECK (seo_title IS NULL OR length(seo_title) <= 70),
    seo_description TEXT CHECK (seo_description IS NULL OR length(seo_description) <= 160),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    UNIQUE (product_id, locale),
    FOREIGN KEY (product_id)
      REFERENCES catalog_products(id) ON UPDATE RESTRICT ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_catalog_product_content_locale
    ON catalog_product_content(locale, product_id);

  CREATE TABLE catalog_product_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    locale TEXT NOT NULL,
    section_key TEXT NOT NULL
      CHECK (length(trim(section_key)) BETWEEN 1 AND 80),
    section_type TEXT NOT NULL DEFAULT 'TEXT'
      CHECK (section_type IN ('TEXT', 'FEATURE_LIST', 'NOTICE')),
    title TEXT CHECK (title IS NULL OR length(title) <= 200),
    body_text TEXT NOT NULL CHECK (length(body_text) BETWEEN 1 AND 10000),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    UNIQUE (product_id, locale, section_key),
    FOREIGN KEY (product_id, locale)
      REFERENCES catalog_product_content(product_id, locale)
      ON UPDATE RESTRICT ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_catalog_product_sections_product_sort
    ON catalog_product_sections(product_id, locale, sort_order, id);

  CREATE TABLE catalog_product_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'IMAGE'
      CHECK (media_type = 'IMAGE'),
    media_usage TEXT NOT NULL DEFAULT 'GALLERY'
      CHECK (media_usage IN ('PRIMARY', 'GALLERY', 'ICON', 'BANNER')),
    url TEXT NOT NULL
      CHECK (
        length(url) BETWEEN 1 AND 500
        AND (
          (
            substr(url, 1, 1) = '/'
            AND substr(url, 1, 2) <> '//'
          )
          OR lower(substr(url, 1, 8)) = 'https://'
        )
      ),
    alt_text TEXT NOT NULL CHECK (length(trim(alt_text)) BETWEEN 1 AND 250),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    CHECK (
      (is_primary = 1 AND media_usage = 'PRIMARY')
      OR (is_primary = 0 AND media_usage <> 'PRIMARY')
    ),
    FOREIGN KEY (product_id)
      REFERENCES catalog_products(id) ON UPDATE RESTRICT ON DELETE CASCADE
  ) STRICT;

  CREATE UNIQUE INDEX uq_catalog_product_media_primary
    ON catalog_product_media(product_id)
    WHERE is_primary = 1;
  CREATE INDEX idx_catalog_product_media_product_sort
    ON catalog_product_media(product_id, sort_order, id);

  CREATE TABLE catalog_product_specs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    locale TEXT NOT NULL,
    spec_key TEXT NOT NULL CHECK (length(trim(spec_key)) BETWEEN 1 AND 80),
    group_key TEXT NOT NULL CHECK (length(trim(group_key)) BETWEEN 1 AND 80),
    group_label TEXT NOT NULL CHECK (length(trim(group_label)) BETWEEN 1 AND 120),
    spec_label TEXT NOT NULL CHECK (length(trim(spec_label)) BETWEEN 1 AND 120),
    spec_value TEXT NOT NULL CHECK (length(trim(spec_value)) BETWEEN 1 AND 500),
    unit TEXT CHECK (unit IS NULL OR length(unit) <= 30),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    UNIQUE (product_id, spec_key, locale),
    FOREIGN KEY (product_id, locale)
      REFERENCES catalog_product_content(product_id, locale)
      ON UPDATE RESTRICT ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_catalog_product_specs_group_sort
    ON catalog_product_specs(product_id, locale, group_key, sort_order, id);

  CREATE TABLE catalog_brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_code TEXT NOT NULL UNIQUE
      CHECK (length(trim(brand_code)) BETWEEN 1 AND 50),
    slug TEXT NOT NULL UNIQUE
      CHECK (
        length(slug) BETWEEN 1 AND 100
        AND slug = lower(slug)
        AND instr(slug, ' ') = 0
      ),
    brand_name TEXT NOT NULL CHECK (length(trim(brand_name)) BETWEEN 1 AND 120),
    description TEXT CHECK (description IS NULL OR length(description) <= 1000),
    website_url TEXT
      CHECK (
        website_url IS NULL
        OR (
          length(website_url) <= 500
          AND lower(substr(website_url, 1, 8)) = 'https://'
        )
      ),
    logo_url TEXT
      CHECK (
        logo_url IS NULL
        OR (
          length(logo_url) <= 500
          AND (
            (
              substr(logo_url, 1, 1) = '/'
              AND substr(logo_url, 1, 2) <> '//'
            )
            OR lower(substr(logo_url, 1, 8)) = 'https://'
          )
        )
      ),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
  ) STRICT;

  CREATE INDEX idx_catalog_brands_active_sort
    ON catalog_brands(is_active, sort_order, id);

  CREATE TABLE catalog_product_brands (
    product_id INTEGER NOT NULL,
    brand_id INTEGER NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (product_id, brand_id),
    FOREIGN KEY (product_id)
      REFERENCES catalog_products(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    FOREIGN KEY (brand_id)
      REFERENCES catalog_brands(id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT;

  CREATE UNIQUE INDEX uq_catalog_product_brands_primary
    ON catalog_product_brands(product_id)
    WHERE is_primary = 1;
  CREATE INDEX idx_catalog_product_brands_brand
    ON catalog_product_brands(brand_id, sort_order, product_id);

  CREATE TABLE catalog_promotion_products (
    promotion_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (promotion_id, product_id),
    FOREIGN KEY (promotion_id)
      REFERENCES promotions(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    FOREIGN KEY (product_id)
      REFERENCES catalog_products(id) ON UPDATE RESTRICT ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_catalog_promotion_products_product
    ON catalog_promotion_products(product_id, promotion_id);
`;

export const CATALOG_V2_DOWN_SQL = `
  DROP TABLE catalog_promotion_products;
  DROP TABLE catalog_product_brands;
  DROP TABLE catalog_product_categories;
  DROP TABLE catalog_product_specs;
  DROP TABLE catalog_product_media;
  DROP TABLE catalog_product_sections;
  DROP TABLE catalog_product_content;
  DROP TABLE catalog_products;
  DROP TABLE catalog_brands;
  DROP TABLE catalog_categories;
`;

export const CATALOG_V2_MIGRATION = Object.freeze({
  version: 2,
  name: 'create_catalog_v2_schema',
  up(database) {
    database.exec(CATALOG_V2_UP_SQL);
  },
  down(database) {
    database.exec(CATALOG_V2_DOWN_SQL);
  },
});
