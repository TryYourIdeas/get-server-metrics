CREATE TABLE "host_thresholds" (
	"host_id" text PRIMARY KEY NOT NULL,
	"cpu_percent" real,
	"cpu_consecutive" integer,
	"memory_percent" real,
	"disk_percent" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threshold_defaults" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"cpu_percent" real NOT NULL,
	"cpu_consecutive" integer NOT NULL,
	"memory_percent" real NOT NULL,
	"disk_percent" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
