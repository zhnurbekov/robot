import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AnnounceMonitorService } from './announce-monitor.service';

@Injectable()
export class AnnounceMonitorScheduler implements OnModuleInit {
  private readonly logger = new Logger(AnnounceMonitorScheduler.name);
  private isEnabled: boolean = true;
  private isRunning: boolean = false; // Флаг для предотвращения параллельного выполнения

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
      this.logger.log(`Мониторинг избранных объявлений: каждую секунду`);
      console.log(`[AnnounceMonitorScheduler] Инициализирован для мониторинга избранных объявлений`);
      console.log(`[AnnounceMonitorScheduler] Проверка статусов каждую секунду`);
    } else {
      this.logger.log('AnnounceMonitorScheduler отключен (ANNOUNCE_MONITOR_ENABLED=false)');
    }
  }

  /**
   * Мониторинг статусов избранных объявлений
   * Проверяет статусы каждую секунду и вызывает API start для объявлений со статусом "Опубликовано (прием заявок)"
   */
  @Interval(1000) // 1000 мс = 1 секунда
  async handleInterval() {
    if (!this.isEnabled) {
      return;
    }

    // Предотвращаем параллельное выполнение, если предыдущая задача еще не завершилась
    if (this.isRunning) {
      this.logger.debug('Предыдущая задача мониторинга еще выполняется, пропускаем этот запуск');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    try {
      this.logger.debug(`[${timestamp}] Запуск задачи мониторинга избранных объявлений`);
      await this.announceMonitorService.monitorFavoritesStatus();
      const duration = Date.now() - startTime;
      this.logger.debug(`Задача мониторинга выполнена за ${duration} мс`);
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Ошибка в задаче мониторинга избранных объявлений (выполнялась ${duration} мс): ${error.message}`);
      if (error.stack) {
        this.logger.debug(error.stack);
      }
    } finally {
      this.isRunning = false;
    }
  }

}

