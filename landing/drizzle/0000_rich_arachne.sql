CREATE TABLE "landing_download" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" varchar(20) NOT NULL,
	"arch" varchar(20) NOT NULL,
	"version" varchar(50) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"country" varchar(2),
	"city" varchar(255),
	"region" varchar(10),
	"visitor_hash" varchar(64),
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landing_page_view" (
	"id" serial PRIMARY KEY NOT NULL,
	"path" varchar(255) NOT NULL,
	"referrer" text,
	"country" varchar(2),
	"city" varchar(255),
	"region" varchar(10),
	"visitor_hash" varchar(64),
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "landing_dl_platform_idx" ON "landing_download" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "landing_dl_version_idx" ON "landing_download" USING btree ("version");--> statement-breakpoint
CREATE INDEX "landing_dl_created_at_idx" ON "landing_download" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "landing_dl_country_idx" ON "landing_download" USING btree ("country");--> statement-breakpoint
CREATE INDEX "landing_pv_path_idx" ON "landing_page_view" USING btree ("path");--> statement-breakpoint
CREATE INDEX "landing_pv_created_at_idx" ON "landing_page_view" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "landing_pv_country_idx" ON "landing_page_view" USING btree ("country");--> statement-breakpoint
CREATE INDEX "landing_pv_visitor_hash_idx" ON "landing_page_view" USING btree ("visitor_hash");