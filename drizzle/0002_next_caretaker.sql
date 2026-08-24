CREATE TABLE `team_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`team_name` text DEFAULT '产品链接管家' NOT NULL,
	`subtitle` text DEFAULT '团队产品资料安全同步' NOT NULL,
	`theme_color` text DEFAULT '#187657' NOT NULL,
	`avatar_key` text,
	`updated_by` text DEFAULT 'system' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
