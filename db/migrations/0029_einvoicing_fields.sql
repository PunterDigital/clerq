ALTER TABLE "business" ADD COLUMN "iban" text;--> statement-breakpoint
ALTER TABLE "business" ADD COLUMN "bic" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "buyer_reference" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "vatex_code" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "buyer_reference" text;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "unit_code" text DEFAULT 'C62' NOT NULL;--> statement-breakpoint
-- Lines generated from time carry hours; everything else is a fixed amount (C62).
UPDATE "invoice_line" SET "unit_code" = 'HUR' WHERE "quantity" IS NOT NULL;