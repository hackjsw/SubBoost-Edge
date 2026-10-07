ALTER TABLE "SubscriptionAutoUpdateState"
  ADD COLUMN "nodeQuotaFailureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastNodeQuotaExceededAt" TIMESTAMP(3),
  ADD COLUMN "lastNodeQuotaActual" INTEGER,
  ADD COLUMN "lastNodeQuotaLimit" INTEGER;
