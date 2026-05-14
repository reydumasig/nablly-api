export type CommissionTypeLiteral = 'saas' | 'setup' | 'saas_setup' | 'adhoc' | 'gmv_flat' | 'gmv_none'

export type CommissionResult = {
  amount: number
  type: CommissionTypeLiteral
}

/**
 * Calculate commission for an invoice based on type and amount.
 *
 * Rules:
 * - saas / setup / adhoc: 5% of invoice amount
 * - gmv_recharge > ₱50,000: ₱1,000 flat fee
 * - gmv_recharge ≤ ₱50,000: ₱0
 */
export function calcCommission(invoiceType: string, amount: number): CommissionResult {
  switch (invoiceType) {
    case 'saas':
      return { amount: parseFloat((amount * 0.05).toFixed(2)), type: 'saas' }

    case 'setup':
      return { amount: parseFloat((amount * 0.05).toFixed(2)), type: 'setup' }

    case 'adhoc':
      return { amount: parseFloat((amount * 0.05).toFixed(2)), type: 'adhoc' }

    case 'gmv_recharge':
      if (amount > 50000) {
        return { amount: 1000, type: 'gmv_flat' }
      }
      return { amount: 0, type: 'gmv_none' }

    default:
      return { amount: 0, type: 'gmv_none' }
  }
}
