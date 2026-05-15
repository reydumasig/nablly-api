/**
 * Sprint 1 — Reimbursement workflow migration
 * Run with: npx tsx migrate-reimbursements-sprint1.ts
 *
 * Safe to re-run: all statements use IF NOT EXISTS / ADD VALUE IF NOT EXISTS.
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  console.log('🚀  Sprint 1 reimbursement migration starting…')

  // ── 1. Expand ReimbursementType enum ──────────────────────────────────────
  const newTypes = [
    'invoice_facilitation',
    'banking_facilitation',
    'client_coordination',
    'courier_services',
    'government_processing',
    'transportation',
    'compliance_processing',
    'miscellaneous',
  ]
  for (const val of newTypes) {
    await db.$executeRawUnsafe(
      `ALTER TYPE "ReimbursementType" ADD VALUE IF NOT EXISTS '${val}'`,
    )
    console.log(`  ✓ ReimbursementType += ${val}`)
  }

  // ── 2. Expand ReimbursementStatus enum ────────────────────────────────────
  const newStatuses = [
    'draft',
    'submitted',
    'under_review',
    'clarification_needed',
    'pending_final',
    'published_to_xoxoday',
    'in_reconciliation',
    'closed',
  ]
  for (const val of newStatuses) {
    await db.$executeRawUnsafe(
      `ALTER TYPE "ReimbursementStatus" ADD VALUE IF NOT EXISTS '${val}'`,
    )
    console.log(`  ✓ ReimbursementStatus += ${val}`)
  }

  // ── 3. Add new columns to reimbursements ──────────────────────────────────
  const columns: [string, string][] = [
    ['display_id',          'VARCHAR(60)'],
    ['expense_category',    'VARCHAR(100)'],
    ['expense_date',        'TIMESTAMPTZ'],
    ['currency',            "VARCHAR(10) NOT NULL DEFAULT 'PHP'"],
    ['client_id_ref',       'TEXT'],
    ['client_name_ref',     'TEXT'],
    ['related_invoice_id',  'TEXT'],
    ['invoice_url',         'TEXT'],
    ['supporting_doc_url',  'TEXT'],
    ['finance_reviewer_id', 'TEXT'],
    ['finance_reviewed_at', 'TIMESTAMPTZ'],
  ]

  for (const [col, type] of columns) {
    await db.$executeRawUnsafe(
      `ALTER TABLE reimbursements ADD COLUMN IF NOT EXISTS "${col}" ${type}`,
    )
    console.log(`  ✓ reimbursements.${col} added`)
  }

  // Unique index on display_id (ignore if already exists)
  await db.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS reimbursements_display_id_key
    ON reimbursements (display_id)
    WHERE display_id IS NOT NULL
  `)
  console.log('  ✓ unique index on display_id')

  // ── 4. Create reimbursement_audit_logs table ───────────────────────────────
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS reimbursement_audit_logs (
      id                TEXT        NOT NULL PRIMARY KEY,
      reimbursement_id  TEXT        NOT NULL,
      actor_id          TEXT        NOT NULL,
      action            VARCHAR(100) NOT NULL,
      comment           TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_reimb_audit_reimbursement
        FOREIGN KEY (reimbursement_id) REFERENCES reimbursements(id) ON DELETE CASCADE,
      CONSTRAINT fk_reimb_audit_actor
        FOREIGN KEY (actor_id) REFERENCES users(id)
    )
  `)
  console.log('  ✓ reimbursement_audit_logs table created')

  // Index for fast lookup by reimbursement
  await db.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_reimb_audit_reimbursement_id
    ON reimbursement_audit_logs (reimbursement_id)
  `)
  console.log('  ✓ index on reimbursement_audit_logs.reimbursement_id')

  console.log('\n✅  Migration complete!')
}

main()
  .catch((e) => {
    console.error('❌  Migration failed:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
