ALTER TABLE `products` ADD `mechanism` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `commission` real DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `products`
SET `mechanism` = COALESCE((SELECT `mechanism` FROM `product_links` WHERE `product_links`.`product_id` = `products`.`id` ORDER BY `created_at` LIMIT 1), ''),
    `commission` = COALESCE((SELECT `commission` FROM `product_links` WHERE `product_links`.`product_id` = `products`.`id` ORDER BY `created_at` LIMIT 1), 0);
