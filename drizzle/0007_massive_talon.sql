CREATE TABLE "usage_daily" (
	"user_id" bigint NOT NULL,
	"day" date NOT NULL,
	"llm_prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"llm_completion_tokens" bigint DEFAULT 0 NOT NULL,
	"embedding_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "usage_daily_user_id_day_pk" PRIMARY KEY("user_id","day")
);
