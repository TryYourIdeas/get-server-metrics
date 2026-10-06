CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"value" real NOT NULL,
	"threshold" real NOT NULL,
	"mount" text DEFAULT '' NOT NULL,
	CONSTRAINT "events_dedupe" UNIQUE("host_id","ts","kind","state","mount")
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"host_id" text PRIMARY KEY NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "samples_ts_idx";--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "host_id" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
CREATE INDEX "events_host_ts_idx" ON "events" USING btree ("host_id","ts");--> statement-breakpoint
CREATE INDEX "samples_host_ts_idx" ON "samples" USING btree ("host_id","ts");--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_host_ts_unique" UNIQUE("host_id","ts");