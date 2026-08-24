CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`member_email` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`member_email`) REFERENCES `members`(`email`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_member_email_idx` ON `sessions` (`member_email`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `members` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `members` ADD `password_salt` text;--> statement-breakpoint
ALTER TABLE `members` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `failed_login_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `locked_until` text;