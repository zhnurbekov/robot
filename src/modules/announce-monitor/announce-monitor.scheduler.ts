import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AnnounceMonitorService } from './announce-monitor.service';

@Injectable()
export class AnnounceMonitorScheduler implements OnModuleInit {
  private readonly logger = new Logger(AnnounceMonitorScheduler.name);
  private isEnabled: boolean = true;

  constructor(
    private announceMonitorService: AnnounceMonitorService,
    private configService: ConfigService,
  ) {
  }

  onModuleInit() {
    const enabled = this.configService.get<string>('ANNOUNCE_MONITOR_ENABLED', 'true') === 'true';
    this.isEnabled = enabled;

    if (enabled) {
      this.logger.log(`AnnounceMonitorScheduler инициализирован`);
      this.logger.log(`Мониторинг избранных объявлений: каждые 30 секунд`);
      console.log(`[AnnounceMonitorScheduler] Инициализирован для мониторинга избранных объявлений`);
      console.log(`[AnnounceMonitorScheduler] Проверка статусов каждые 30 секунд`);
    } else {
      this.logger.log('AnnounceMonitorScheduler отключен (ANNOUNCE_MONITOR_ENABLED=false)');
    }
  }

  /**
   * Мониторинг статусов избранных объявлений
   * Проверяет статусы каждые 30 секунд и вызывает API start для объявлений со статусом "Опубликовано (прием заявок)"
   */
  @Interval(1000) // 30000 мс = 30 секунд
  async handleInterval() {
    if (!this.isEnabled) {
      return;
    }

    try {
      await this.announceMonitorService.monitorFavoritesStatus();
    } catch (error) {
      this.logger.error(`Ошибка в задаче мониторинга избранных объявлений: ${error.message}`);
      if (error.stack) {
        this.logger.debug(error.stack);
      }
    }
  }

}

