/**
 * Sprint 3 — AI Validation migration
 * Run with: npx tsx migrate-sprint3-ai-validation.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  console.log('🚀  Sprint 3 AI validation migration starting…')

  // Create the new enum type
  await db.$executeRawUnsafe(`
    DO $$ BEGIN
      CREATE TYPE "AiValidationStatus" AS ENUM ('pending', 'passed', 'warning', 'failed', 'skipped');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `)
  console.log('  ✓ AiValidationStatus enum created')

  // Add new columns to reimbursements
  await db.$executeRawUnsafe(`
    ALTER TABLE reimbursements
      ADD COLUMN IF NOT EXISTS ai_validation_status "AiValidationStatus",
      ADD COLUMN IF NOT EXISTS ai_validation_data    JSONB,
      ADD COLUMN IF NOT EXISTS ai_validated_at       TIMESTAMPTZ
  `)
  console.log('  ✓ ai_validation_status, ai_validation_data, ai_validated_at columns added')

  // Index for fast status queries
  await db.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_reimb_ai_status
    ON reimbursements (ai_validation_status)
    WHERE ai_validation_status IS NOT NULL
  `)
  console.log('  ✓ index on ai_validation_status')

  console.log('\n✅  Migration complete!')
}

main()
  .catch((e) => {
    console.error('❌  Migration failed:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
