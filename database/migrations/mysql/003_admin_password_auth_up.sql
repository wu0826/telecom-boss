CREATE TABLE `staff_password_credentials` (
  `staff_user_id` BIGINT NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `failed_attempts` INT NOT NULL DEFAULT 0,
  `first_failed_at` DATETIME(3) NULL,
  `locked_until` DATETIME(3) NULL,
  `password_changed_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`staff_user_id`),
  KEY `idx_staff_password_credentials_locked_until` (`locked_until`),
  CONSTRAINT `chk_staff_password_credentials_failed_attempts`
    CHECK (`failed_attempts` >= 0),
  CONSTRAINT `fk_staff_password_credentials_staff_user`
    FOREIGN KEY (`staff_user_id`) REFERENCES `staff_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
