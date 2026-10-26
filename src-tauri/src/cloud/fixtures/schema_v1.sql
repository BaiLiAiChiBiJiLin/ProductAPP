CREATE TABLE `user` (
  `id` char(36) COLLATE utf8mb4_bin NOT NULL,
  `name` varchar(120) COLLATE utf8mb4_bin NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE `pf_schema` (
  `id` int NOT NULL,
  `version` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
CREATE TABLE `pf_records` (
  `kind` varchar(24) COLLATE utf8mb4_bin NOT NULL,
  `id` varchar(190) COLLATE utf8mb4_bin NOT NULL,
  `owner_id` char(36) COLLATE utf8mb4_bin DEFAULT NULL,
  `version` bigint unsigned NOT NULL,
  `name` varchar(512) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `saved_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `status` varchar(24) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `source_review_id` varchar(190) COLLATE utf8mb4_bin DEFAULT NULL,
  `summary` json NOT NULL,
  `payload` json NOT NULL,
  PRIMARY KEY (`kind`,`id`),
  UNIQUE KEY `one_production_per_review` (`source_review_id`),
  KEY `list_owner` (`kind`,`owner_id`,`saved_at`),
  KEY `list_public` (`kind`,`status`,`saved_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE `pf_resources` (
  `id` char(64) COLLATE utf8mb4_bin NOT NULL,
  `relative_path` varchar(1024) COLLATE utf8mb4_bin NOT NULL,
  `bytes` bigint unsigned NOT NULL,
  `released_at` timestamp(3) NULL DEFAULT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE `pf_resource_refs` (
  `kind` varchar(24) COLLATE utf8mb4_bin NOT NULL,
  `record_id` varchar(190) COLLATE utf8mb4_bin NOT NULL,
  `resource_id` char(64) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`kind`,`record_id`,`resource_id`),
  KEY `by_resource` (`resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE `pf_requests` (
  `id` char(36) COLLATE utf8mb4_bin NOT NULL,
  `user_id` char(36) COLLATE utf8mb4_bin NOT NULL,
  `digest` char(64) COLLATE utf8mb4_bin NOT NULL,
  `response` json NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE `pf_transfers` (
  `id` char(36) COLLATE utf8mb4_bin NOT NULL,
  `batch_id` varchar(190) COLLATE utf8mb4_bin NOT NULL,
  `from_user` char(36) COLLATE utf8mb4_bin NOT NULL,
  `to_user` char(36) COLLATE utf8mb4_bin NOT NULL,
  `transferred_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE `pf_custom_products` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(190) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `custom_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE `pf_migrations` (
  `installation` char(36) COLLATE utf8mb4_bin NOT NULL,
  `kind` varchar(24) COLLATE utf8mb4_bin NOT NULL,
  `local_id` varchar(190) COLLATE utf8mb4_bin NOT NULL,
  `cloud_id` varchar(190) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`installation`,`kind`,`local_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
