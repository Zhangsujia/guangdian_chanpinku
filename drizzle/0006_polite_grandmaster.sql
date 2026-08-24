ALTER TABLE `members` ADD `can_edit` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `can_delete` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `sku` text DEFAULT '' NOT NULL;