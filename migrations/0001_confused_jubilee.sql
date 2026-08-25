CREATE TABLE `sign_script` (
	`id` integer PRIMARY KEY NOT NULL,
	`script` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "sign_script_singleton" CHECK("sign_script"."id" = 1)
);
