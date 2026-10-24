CREATE TABLE `dataset_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dataset_id` integer NOT NULL,
	`from_time` integer NOT NULL,
	`to_time` integer NOT NULL,
	`fetched_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `market_data_datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `coverage_dataset` ON `dataset_coverage` (`dataset_id`,`from_time`);--> statement-breakpoint
ALTER TABLE `account_equity_snapshots` ADD `used_margin` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_sessions` ADD `leverage` real;--> statement-breakpoint
ALTER TABLE `backtest_sessions` ADD `conversion_dataset_id` integer REFERENCES market_data_datasets(id);--> statement-breakpoint
ALTER TABLE `backtest_sessions` ADD `conversion_invert` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `candles` ADD `spread` real;--> statement-breakpoint
ALTER TABLE `executions` ADD `fx_rate` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `instruments` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `instruments` ADD `unit` text DEFAULT 'coin' NOT NULL;--> statement-breakpoint
ALTER TABLE `instruments` ADD `leverage` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `instruments` ADD `calendar` text DEFAULT '24x7' NOT NULL;--> statement-breakpoint
ALTER TABLE `instruments` ADD `time_zone` text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE `instruments` ADD `financing` text;--> statement-breakpoint
ALTER TABLE `instruments` ADD `provider_symbol` text;--> statement-breakpoint
ALTER TABLE `market_data_datasets` ADD `price_basis` text DEFAULT 'trade' NOT NULL;--> statement-breakpoint
ALTER TABLE `market_data_datasets` ADD `meta` text;--> statement-breakpoint
ALTER TABLE `paper_accounts` ADD `stop_out_level` real DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `financing` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `margin` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_journal` ADD `financing` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_journal` ADD `account_currency` text DEFAULT 'USDT' NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_journal` ADD `quote_currency` text;