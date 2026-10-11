SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'free';
