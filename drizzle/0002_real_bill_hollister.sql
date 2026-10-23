CREATE TYPE "public"."reservationStatus" AS ENUM('reserved', 'done');--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"slotId" text NOT NULL,
	"userId" text NOT NULL,
	"status" "reservationStatus" DEFAULT 'reserved' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_slotId_unique" UNIQUE("slotId")
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_slotId_slots_id_fk" FOREIGN KEY ("slotId") REFERENCES "public"."slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;