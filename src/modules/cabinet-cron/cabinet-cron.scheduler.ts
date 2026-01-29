import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CabinetCronService } from './cabinet-cron.service';

@Injectable()
export class CabinetCronScheduler implements OnModuleInit {
  private readonly logger = new Logger(CabinetCronScheduler.name);
  private isEnabled = true;

  constructor(
    private cabinetCronService: CabinetCronService,
    private configService: ConfigService,
  ) {}

  onModuleInit() {
    const enabled = this.configService.get<string>('CABINET_CRON_ENABLED', 'true') === 'true';
    this.isEnabled = enabled;

    if (enabled) {
      this.logger.log('CabinetCronScheduler инициализирован: запросы tax_debts и permits каждый час');
    } else {
      this.logger.log('CabinetCronScheduler отключен (CABINET_CRON_ENABLED=false)');
    }
  }

  /**
   * Каждый час: POST tax_debts и POST permits
   */
  @Cron('0 * * * *') // каждый час в 0 минут (00:00, 01:00, 02:00, ...)
  async handleHourlyCron() {
    if (!this.isEnabled) return;

    try {
      await this.cabinetCronService.runHourlyRequests();
    } catch (error) {
      this.logger.error(`Ошибка в почасовой задаче кабинета: ${(error as Error).message}`);
    }
  }
}
