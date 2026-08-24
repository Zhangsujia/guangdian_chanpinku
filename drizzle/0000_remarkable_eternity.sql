CREATE TABLE `activity_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`product_name` text,
	`summary` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_logs_created_at_idx` ON `activity_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `activity_logs_actor_email_idx` ON `activity_logs` (`actor_email`);--> statement-breakpoint
CREATE TABLE `members` (
	`email` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`invited_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_links` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`platform` text NOT NULL,
	`url` text NOT NULL,
	`mechanism` text NOT NULL,
	`commission` real NOT NULL,
	`status` text DEFAULT '有效' NOT NULL,
	`last_checked_at` text,
	`check_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_links_product_platform_unique` ON `product_links` (`product_id`,`platform`);--> statement-breakpoint
CREATE INDEX `product_links_product_id_idx` ON `product_links` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_links_status_idx` ON `product_links` (`status`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`manufacturer` text DEFAULT '未填写' NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_normalized_name_unique` ON `products` (`normalized_name`);--> statement-breakpoint
CREATE INDEX `products_deleted_at_idx` ON `products` (`deleted_at`);