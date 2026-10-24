CREATE TABLE `account_equity_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`time` integer NOT NULL,
	`balance` real NOT NULL,
	`equity` real NOT NULL,
	`unrealized` real NOT NULL,
	`open_positions` integer NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshots_account_time_reason` ON `account_equity_snapshots` (`account_id`,`time`,`reason`);--> statement-breakpoint
CREATE TABLE `backtest_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`instrument_id` text NOT NULL,
	`dataset_id` integer NOT NULL,
	`timeframe` text NOT NULL,
	`start_time` integer NOT NULL,
	`end_time` integer NOT NULL,
	`initial_cursor_time` integer NOT NULL,
	`cursor_time` integer NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`data_version` integer NOT NULL,
	`data_checksum` text NOT NULL,
	`gap_count` integer DEFAULT 0 NOT NULL,
	`strategy_id` integer,
	`resolve_lower_tf` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dataset_id`) REFERENCES `market_data_datasets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_updated` ON `backtest_sessions` (`updated_at`);--> statement-breakpoint
CREATE TABLE `candles` (
	`dataset_id` integer NOT NULL,
	`time` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real NOT NULL,
	PRIMARY KEY(`dataset_id`, `time`),
	FOREIGN KEY (`dataset_id`) REFERENCES `market_data_datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `executions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`order_id` text NOT NULL,
	`position_id` text NOT NULL,
	`symbol` text NOT NULL,
	`kind` text NOT NULL,
	`side` text NOT NULL,
	`qty` real NOT NULL,
	`price` real NOT NULL,
	`reference_price` real NOT NULL,
	`fee` real NOT NULL,
	`spread_cost` real NOT NULL,
	`slippage_cost` real NOT NULL,
	`liquidity` text NOT NULL,
	`reason` text NOT NULL,
	`time` integer NOT NULL,
	`flags` text NOT NULL,
	`recorded_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `executions_account_time` ON `executions` (`account_id`,`time`);--> statement-breakpoint
CREATE TABLE `instruments` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`symbol` text NOT NULL,
	`market` text NOT NULL,
	`base_asset` text,
	`quote_asset` text,
	`tick_size` real NOT NULL,
	`qty_step` real NOT NULL,
	`min_qty` real NOT NULL,
	`contract_size` real DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `market_data_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instruments_source_symbol` ON `instruments` (`source_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `live_symbol_cursors` (
	`symbol` text PRIMARY KEY NOT NULL,
	`processed_until` integer NOT NULL,
	`last_price` real,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_data_datasets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`instrument_id` text NOT NULL,
	`timeframe` text NOT NULL,
	`label` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`first_time` integer,
	`last_time` integer,
	`candle_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `market_data_sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datasets_unique` ON `market_data_datasets` (`source_id`,`instrument_id`,`timeframe`,`label`);--> statement-breakpoint
CREATE TABLE `market_data_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`session_id` text,
	`client_order_id` text NOT NULL,
	`instrument_id` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`type` text NOT NULL,
	`qty` real NOT NULL,
	`price` real,
	`sl` real,
	`tp` real,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`active_from` integer NOT NULL,
	`filled_at` integer,
	`cancelled_at` integer,
	`reject_reason` text,
	`strategy_id` integer,
	`timeframe` text NOT NULL,
	`mode` text NOT NULL,
	`entry_note` text,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `backtest_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_client_id` ON `orders` (`account_id`,`client_order_id`);--> statement-breakpoint
CREATE INDEX `orders_account_status` ON `orders` (`account_id`,`status`);--> statement-breakpoint
CREATE TABLE `paper_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text DEFAULT 'USDT' NOT NULL,
	`starting_balance` real NOT NULL,
	`balance` real NOT NULL,
	`costs` text NOT NULL,
	`risk_percent` real DEFAULT 1 NOT NULL,
	`event_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`session_id` text,
	`order_id` text NOT NULL,
	`instrument_id` text NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`qty` real NOT NULL,
	`entry_price` real NOT NULL,
	`entry_time` integer NOT NULL,
	`sl` real,
	`tp` real,
	`initial_sl` real,
	`initial_tp` real,
	`initial_risk` real,
	`status` text NOT NULL,
	`exit_price` real,
	`exit_time` integer,
	`exit_reason` text,
	`entry_fee` real NOT NULL,
	`exit_fee` real DEFAULT 0 NOT NULL,
	`slippage_cost` real DEFAULT 0 NOT NULL,
	`gross_pnl` real,
	`net_pnl` real,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `backtest_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `positions_order_id_unique` ON `positions` (`order_id`);--> statement-breakpoint
CREATE INDEX `positions_account_status` ON `positions` (`account_id`,`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `simulation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`session_id` text,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`sim_time` integer NOT NULL,
	`wall_time` integer NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_account_seq` ON `simulation_events` (`account_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_session` ON `simulation_events` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strategies_name_unique` ON `strategies` (`name`);--> statement-breakpoint
CREATE TABLE `trade_journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` text NOT NULL,
	`account_id` text NOT NULL,
	`session_id` text,
	`mode` text NOT NULL,
	`symbol` text NOT NULL,
	`market` text NOT NULL,
	`strategy_id` integer,
	`strategy_name` text,
	`timeframe` text NOT NULL,
	`direction` text NOT NULL,
	`entry_time` integer NOT NULL,
	`exit_time` integer NOT NULL,
	`entry_price` real NOT NULL,
	`exit_price` real NOT NULL,
	`qty` real NOT NULL,
	`initial_sl` real,
	`initial_tp` real,
	`final_sl` real,
	`final_tp` real,
	`gross_pnl` real NOT NULL,
	`net_pnl` real NOT NULL,
	`fees` real NOT NULL,
	`slippage_cost` real NOT NULL,
	`initial_risk` real,
	`r_multiple` real,
	`holding_ms` integer NOT NULL,
	`entry_reason` text NOT NULL,
	`exit_reason` text NOT NULL,
	`data_source` text NOT NULL,
	`data_version` text NOT NULL,
	`flags` text NOT NULL,
	`notes` text,
	`setup_quality` integer,
	`rule_followed` integer,
	`tags` text,
	`annotations` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trade_journal_position_id_unique` ON `trade_journal` (`position_id`);--> statement-breakpoint
CREATE INDEX `journal_exit_time` ON `trade_journal` (`exit_time`);--> statement-breakpoint
CREATE INDEX `journal_filters` ON `trade_journal` (`mode`,`symbol`,`strategy_id`,`timeframe`);