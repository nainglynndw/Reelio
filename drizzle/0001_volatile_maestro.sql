CREATE TABLE `subscriptions` (
	`user_id` text PRIMARY KEY NOT NULL,
	`plan_code` text NOT NULL,
	`status` text NOT NULL,
	`included_renders` integer DEFAULT 0 NOT NULL,
	`renders_used` integer DEFAULT 0 NOT NULL,
	`current_period_start` text NOT NULL,
	`current_period_end` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
