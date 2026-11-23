CREATE TABLE "fx_rate" (
	"rate_date" date NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate" text NOT NULL,
	"effective_date" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rate_rate_date_base_quote_pk" PRIMARY KEY("rate_date","base","quote")
);
