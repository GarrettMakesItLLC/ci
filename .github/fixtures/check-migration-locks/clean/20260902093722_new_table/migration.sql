-- CreateTable
CREATE TABLE "Widget" ("id" TEXT NOT NULL, CONSTRAINT "Widget_pkey" PRIMARY KEY ("id"));

-- CreateIndex
CREATE INDEX "Widget_id_idx" ON "Widget"("id");
