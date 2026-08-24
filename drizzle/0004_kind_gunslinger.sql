CREATE TABLE `product_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`price` real NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_packages_product_name_unique` ON `product_packages` (`product_id`,`normalized_name`);--> statement-breakpoint
CREATE INDEX `product_packages_product_id_idx` ON `product_packages` (`product_id`);