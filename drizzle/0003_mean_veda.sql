CREATE TABLE "announcements" (
	"id" text PRIMARY KEY NOT NULL,
	"seminarDayId" text NOT NULL,
	"authorId" text NOT NULL,
	"body" text NOT NULL,
	"displayFrom" date,
	"displayUntil" date,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_displayFrom_displayUntil_check" CHECK ("announcements"."displayFrom" <= "announcements"."displayUntil")
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_seminarDayId_seminarDays_id_fk" FOREIGN KEY ("seminarDayId") REFERENCES "public"."seminarDays"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;