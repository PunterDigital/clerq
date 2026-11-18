CREATE TABLE "credit_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"number" text NOT NULL,
	"year" integer NOT NULL,
	"currency" text NOT NULL,
	"issue_date" timestamp with time zone NOT NULL,
	"tax_treatment" text NOT NULL,
	"tax_rate_percent" text DEFAULT '0' NOT NULL,
	"tax_note" text,
	"vatex_code" text,
	"buyer_reference" text,
	"subtotal_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"reason" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_note_business_number_unique" UNIQUE("business_id","number")
);
--> statement-breakpoint
CREATE TABLE "credit_note_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" text,
	"unit_price_minor" integer,
	"total_minor" integer NOT NULL,
	"unit_code" text DEFAULT 'C62' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_note_sequence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_note_sequence_business_year_unique" UNIQUE("business_id","year")
);
--> statement-breakpoint
ALTER TABLE "business" ADD COLUMN "credit_note_prefix" text DEFAULT 'CN-' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "credited_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "einvoice_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_credit_note_id_credit_note_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_invoice_line_id_invoice_line_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_sequence" ADD CONSTRAINT "credit_note_sequence_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_note_business_id_idx" ON "credit_note" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "credit_note_invoice_id_idx" ON "credit_note" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "credit_note_line_business_id_idx" ON "credit_note_line" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "credit_note_line_credit_note_id_idx" ON "credit_note_line" USING btree ("credit_note_id");--> statement-breakpoint
CREATE INDEX "credit_note_line_invoice_line_id_idx" ON "credit_note_line" USING btree ("invoice_line_id");