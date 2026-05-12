import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { OutboundTransferService } from './outbound-transfer.service'

@Injectable()
export class TransferReconcileScheduler {
  private readonly logger = new Logger(TransferReconcileScheduler.name)

  constructor(private readonly outbound: OutboundTransferService) {}

  /** Quotidien 02:00 UTC — réconciliation Transfers `PENDING` > 2 h (CTO Ticket 3.5). */
  @Cron('0 2 * * *')
  async runDailyTransferReconcile(): Promise<void> {
    this.logger.log('transfer.reconcile.cron.start')
    await this.outbound.reconcileStaleTransfersBatch()
    this.logger.log('transfer.reconcile.cron.done')
  }
}
