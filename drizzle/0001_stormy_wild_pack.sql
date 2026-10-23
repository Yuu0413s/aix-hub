CREATE TYPE "public"."seminarDayStatus" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."slotKind" AS ENUM('presentation', 'break', 'teacher_share', 'unavailable');--> statement-breakpoint
CREATE TABLE "seminarDays" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"status" "seminarDayStatus" DEFAULT 'open' NOT NULL,
	"closedReason" text,
	CONSTRAINT "seminarDays_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"id" text PRIMARY KEY NOT NULL,
	"seminarDayId" text NOT NULL,
	"period" smallint NOT NULL,
	"startTime" time NOT NULL,
	"endTime" time NOT NULL,
	"kind" "slotKind" NOT NULL,
	CONSTRAINT "slots_seminarDayId_startTime_unique" UNIQUE("seminarDayId","startTime")
);
--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_seminarDayId_seminarDays_id_fk" FOREIGN KEY ("seminarDayId") REFERENCES "public"."seminarDays"("id") ON DELETE restrict ON UPDATE no action;