ALTER TABLE `product_links` ADD `link_mode` text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE `product_links` ADD `creator_links_json` text DEFAULT '[]' NOT NULL;