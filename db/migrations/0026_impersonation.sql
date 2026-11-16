CREATE TABLE "impersonation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" text NOT NULL,
	"admin_session_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "impersonation" ADD CONSTRAINT "impersonation_admin_user_id_user_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation" ADD CONSTRAINT "impersonation_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "impersonation_admin_session_id_idx" ON "impersonation" USING btree ("admin_session_id");--> statement-breakpoint
CREATE INDEX "impersonation_target_user_id_idx" ON "impersonation" USING btree ("target_user_id");