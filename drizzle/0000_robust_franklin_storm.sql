CREATE TABLE "disk_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"sample_id" integer NOT NULL,
	"mount" text NOT NULL,
	"used" bigint NOT NULL,
	"total" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"cpu_percent" real NOT NULL,
	"mem_used" bigint NOT NULL,
	"mem_total" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "disk_samples" ADD CONSTRAINT "disk_samples_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disk_samples_sample_idx" ON "disk_samples" USING btree ("sample_id");--> statement-breakpoint
CREATE INDEX "samples_ts_idx" ON "samples" USING btree ("ts");