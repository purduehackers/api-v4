CREATE TABLE `attendance_events` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`delta` integer NOT NULL,
	`occurred_at_ms` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `attendance_topics`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attendance_events_delta_check" CHECK("attendance_events"."delta" in (1, -1))
);
--> statement-breakpoint
CREATE INDEX `attendance_events_topic_id_idx` ON `attendance_events` (`topic_id`);--> statement-breakpoint
CREATE INDEX `attendance_events_occurred_at_ms_idx` ON `attendance_events` (`occurred_at_ms`);--> statement-breakpoint
CREATE TABLE `attendance_topics` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_topics_name_unique` ON `attendance_topics` (`name`);--> statement-breakpoint
CREATE INDEX `attendance_topics_name_idx` ON `attendance_topics` (`name`);