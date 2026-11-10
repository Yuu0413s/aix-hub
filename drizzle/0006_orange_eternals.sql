CREATE TYPE "public"."participationStatus" AS ENUM('considering', 'planning', 'submitted');--> statement-breakpoint
CREATE TABLE "conferenceParticipants" (
	"id" text PRIMARY KEY NOT NULL,
	"conferenceId" text NOT NULL,
	"userId" text NOT NULL,
	"status" "participationStatus" NOT NULL,
	CONSTRAINT "conferenceParticipants_conferenceId_userId_unique" UNIQUE("conferenceId","userId")
);
--> statement-breakpoint
CREATE TABLE "conferenceSeries" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "conferenceSeries_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "conferences" (
	"id" text PRIMARY KEY NOT NULL,
	"seriesId" text NOT NULL,
	"title" text NOT NULL,
	"venue" text,
	"url" text,
	"submissionDeadline" date,
	"submissionNote" text,
	"startDate" date,
	"endDate" date,
	"scheduleNote" text,
	"description" text,
	"note" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conferences_title_unique" UNIQUE("title"),
	CONSTRAINT "conferences_startDate_endDate_check" CHECK ("conferences"."startDate" <= "conferences"."endDate")
);
--> statement-breakpoint
ALTER TABLE "conferenceParticipants" ADD CONSTRAINT "conferenceParticipants_conferenceId_conferences_id_fk" FOREIGN KEY ("conferenceId") REFERENCES "public"."conferences"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conferenceParticipants" ADD CONSTRAINT "conferenceParticipants_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conferences" ADD CONSTRAINT "conferences_seriesId_conferenceSeries_id_fk" FOREIGN KEY ("seriesId") REFERENCES "public"."conferenceSeries"("id") ON DELETE restrict ON UPDATE no action;