import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'

const db = new PrismaClient()

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

async function main() {
  console.log('🌱 Seeding N-ablly database...')

  // ── Users ────────────────────────────────────────────────────────────────
  const [admin, manager, employee] = await Promise.all([
    db.user.upsert({
      where: { email: 'admin@nablly.com' },
      update: {},
      create: {
        email: 'admin@nablly.com',
        name: 'Alex Storm',
        password: hashPassword('Admin123!'),
        role: 'admin',
        employeeId: 'EMP-001',
      },
    }),
    db.user.upsert({
      where: { email: 'manager@nablly.com' },
      update: {},
      create: {
        email: 'manager@nablly.com',
        name: 'Maria Santos',
        password: hashPassword('Manager123!'),
        role: 'manager',
        employeeId: 'EMP-002',
      },
    }),
    db.user.upsert({
      where: { email: 'employee@nablly.com' },
      update: {},
      create: {
        email: 'employee@nablly.com',
        name: 'Juan dela Cruz',
        password: hashPassword('Employee123!'),
        role: 'employee',
        employeeId: 'EMP-003',
      },
    }),
  ])
  console.log('  ✓ Users: admin, manager, employee')

  // ── Clients ──────────────────────────────────────────────────────────────
  const [acme, swift, nova] = await Promise.all([
    db.client.upsert({
      where: { id: 'client-001' },
      update: {},
      create: {
        id: 'client-001',
        companyName: 'Acme Corp Philippines',
        type: 'saas',
        birNumber: '123-456-789-000',
        address: '12F Ayala Tower, Makati City',
        contactPerson: 'Roberto Cruz',
        contactEmail: 'roberto@acmecorp.ph',
        contactNumber: '+63 917 123 4567',
        status: 'active',
      },
    }),
    db.client.upsert({
      where: { id: 'client-002' },
      update: {},
      create: {
        id: 'client-002',
        companyName: 'SwiftOps Philippines',
        type: 'gmv',
        birNumber: '987-654-321-000',
        address: '8F BGC Tower 2, Taguig City',
        contactPerson: 'Diana Reyes',
        contactEmail: 'diana@swiftops.ph',
        contactNumber: '+63 918 987 6543',
        status: 'active',
      },
    }),
    db.client.upsert({
      where: { id: 'client-003' },
      update: {},
      create: {
        id: 'client-003',
        companyName: 'Nova Logistics Inc',
        type: 'both',
        birNumber: '456-789-123-000',
        address: '3F Ortigas Center, Pasig City',
        contactPerson: 'Carlo Mendoza',
        contactEmail: 'carlo@novalogistics.ph',
        contactNumber: '+63 919 456 7890',
        status: 'active',
      },
    }),
  ])
  console.log('  ✓ Clients: Acme Corp, SwiftOps, Nova Logistics')

  // ── Invoices ─────────────────────────────────────────────────────────────
  const inv1 = await db.invoice.upsert({
    where: { id: 'inv-001' },
    update: {},
    create: {
      id: 'inv-001',
      requestorId: employee.id,
      clientId: acme.id,
      invoiceType: 'saas',
      amount: 150000,
      dueDate: new Date('2025-06-15'),
      notes: 'Monthly SaaS subscription for May 2025',
      status: 'checker_review',
      commissionAmount: 7500,
      invoiceNumber: null,
    },
  })

  const inv2 = await db.invoice.upsert({
    where: { id: 'inv-002' },
    update: {},
    create: {
      id: 'inv-002',
      requestorId: employee.id,
      clientId: swift.id,
      invoiceType: 'gmv_recharge',
      amount: 80000,
      dueDate: new Date('2025-06-20'),
      notes: 'GMV recharge top-up for May',
      status: 'maker_review',
      commissionAmount: null,
    },
  })

  const inv3 = await db.invoice.upsert({
    where: { id: 'inv-003' },
    update: {},
    create: {
      id: 'inv-003',
      requestorId: employee.id,
      clientId: nova.id,
      invoiceType: 'setup',
      amount: 50000,
      dueDate: new Date('2025-06-30'),
      notes: 'Platform setup fee — onboarding package',
      status: 'paid',
      commissionAmount: 2500,
      invoiceNumber: 'INV-202505-0001',
      sentAt: new Date('2025-05-05'),
      paidAt: new Date('2025-05-10'),
    },
  })
  console.log('  ✓ Invoices: 3 seed records (checker_review, maker_review, paid)')

  // ── Audit Logs ───────────────────────────────────────────────────────────
  await db.invoiceAuditLog.createMany({
    skipDuplicates: true,
    data: [
      { invoiceId: inv1.id, actorId: employee.id, action: 'Submitted invoice request', createdAt: new Date('2025-05-01T09:00:00Z') },
      { invoiceId: inv1.id, actorId: manager.id, action: 'Approved — forwarded to Finance Checker', createdAt: new Date('2025-05-02T10:30:00Z') },
      { invoiceId: inv2.id, actorId: employee.id, action: 'Submitted invoice request', createdAt: new Date('2025-05-03T08:00:00Z') },
      { invoiceId: inv3.id, actorId: employee.id, action: 'Submitted invoice request', createdAt: new Date('2025-04-28T09:00:00Z') },
      { invoiceId: inv3.id, actorId: manager.id, action: 'Approved — forwarded to Finance Checker', createdAt: new Date('2025-04-29T11:00:00Z') },
      { invoiceId: inv3.id, actorId: admin.id, action: 'Final approved', createdAt: new Date('2025-04-30T14:00:00Z') },
      { invoiceId: inv3.id, actorId: admin.id, action: 'Invoice generated: INV-202505-0001', createdAt: new Date('2025-05-04T09:00:00Z') },
      { invoiceId: inv3.id, actorId: admin.id, action: 'Invoice sent to client', createdAt: new Date('2025-05-05T10:00:00Z') },
      { invoiceId: inv3.id, actorId: admin.id, action: 'Marked as paid', createdAt: new Date('2025-05-10T16:00:00Z') },
    ],
  })
  console.log('  ✓ Audit logs seeded')

  // ── Commissions ──────────────────────────────────────────────────────────
  await db.commission.upsert({
    where: { invoiceId: inv1.id },
    update: {},
    create: { invoiceId: inv1.id, amount: 7500, type: 'saas', status: 'pending' },
  })
  await db.commission.upsert({
    where: { invoiceId: inv3.id },
    update: {},
    create: { invoiceId: inv3.id, amount: 2500, type: 'setup', status: 'released' },
  })
  console.log('  ✓ Commissions: 1 pending, 1 released')

  // ── Reimbursements ───────────────────────────────────────────────────────
  await db.reimbursement.createMany({
    skipDuplicates: true,
    data: [
      {
        requestorId: employee.id,
        type: 'collections',
        amount: 3500,
        description: 'Collections run — Acme Corp May payment',
        status: 'approved',
        reviewerId: manager.id,
        reviewedAt: new Date('2025-05-08'),
      },
      {
        requestorId: employee.id,
        type: 'facilitation_expenses',
        amount: 850,
        description: 'Client lunch meeting — SwiftOps onboarding',
        status: 'pending',
      },
    ],
  })
  console.log('  ✓ Reimbursements: 1 approved, 1 pending')

  console.log('\n✅ Seed complete!')
  console.log('\n🔑 Test credentials:')
  console.log('   admin@nablly.com    / Admin123!')
  console.log('   manager@nablly.com  / Manager123!')
  console.log('   employee@nablly.com / Employee123!')
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect())
