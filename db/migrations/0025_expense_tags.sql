CREATE TABLE "expense_tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_tag_link" (
	"business_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_tag_link_expense_id_tag_id_pk" PRIMARY KEY("expense_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "expense_tag" ADD CONSTRAINT "expense_tag_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_tag_link" ADD CONSTRAINT "expense_tag_link_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_tag_link" ADD CONSTRAINT "expense_tag_link_expense_id_expense_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expense"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_tag_link" ADD CONSTRAINT "expense_tag_link_tag_id_expense_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."expense_tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_tag_business_name_idx" ON "expense_tag" USING btree ("business_id",lower("name"));--> statement-breakpoint
CREATE INDEX "expense_tag_link_tag_id_idx" ON "expense_tag_link" USING btree ("tag_id");