CREATE TABLE "gradePromotions" (
	"id" text PRIMARY KEY NOT NULL,
	"academicYear" smallint NOT NULL,
	"executedById" text NOT NULL,
	"executedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gradePromotions_academicYear_unique" UNIQUE("academicYear")
);
--> statement-breakpoint
ALTER TABLE "gradePromotions" ADD CONSTRAINT "gradePromotions_executedById_users_id_fk" FOREIGN KEY ("executedById") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;