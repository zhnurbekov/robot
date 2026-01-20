import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AnnounceMonitorService } from './announce-monitor.service';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';

@Injectable()
export class AnnounceMonitorScheduler implements OnModuleInit {
  private readonly logger = new Logger(AnnounceMonitorScheduler.name);
  private isEnabled: boolean = true;
  private lastStatus: string | null = null;
  private readonly statusChangeLogFile: string;
  private readonly mainAppUrl: string;
  private publishedStatusHandled: boolean = false; // Флаг, чтобы не обрабатывать повторно

  constructor(
    private announceMonitorService: AnnounceMonitorService,
    private configService: ConfigService,
  ) {
    // Путь к файлу для записи времени изменения статуса
    const logDir = path.join(process.cwd(), 'data', 'monitor');
    this.statusChangeLogFile = path.join(logDir, 'status-change.log');
    this.ensureLogDir();
    
    // URL основного приложения
    const mainAppPort = this.configService.get<number>('PORT', 3000);
    this.mainAppUrl = `http://localhost:${mainAppPort}/api/applications/start`;
  }

  private async ensureLogDir(): Promise<void> {
    try {
      const logDir = path.dirname(this.statusChangeLogFile);
      await fs.mkdir(logDir, { recursive: true });
    } catch (error) {
      this.logger.error(`Ошибка создания директории для логов: ${(error as Error).message}`);
    }
  }

  onModuleInit() {
    const enabled = this.configService.get<string>('ANNOUNCE_MONITOR_ENABLED', 'true') === 'true';
    this.isEnabled = enabled;
    const announceId = this.announceMonitorService.getAnnounceId();

    if (enabled) {
      this.logger.log(`AnnounceMonitorScheduler инициализирован`);
      this.logger.log(`Мониторинг объявления ${announceId}: каждую секунду`);
      console.log(`[AnnounceMonitorScheduler] Инициализирован для объявления ${announceId}`);
      console.log(`[AnnounceMonitorScheduler] Проверка статуса каждую секунду`);
    } else {
      this.logger.log('AnnounceMonitorScheduler отключен (ANNOUNCE_MONITOR_ENABLED=false)');
    }
  }

  /**
   * Проверка статуса объявления каждую секунду
   */
  @Interval(1000) // 1000 мс = 1 секунда
  async handleInterval() {
    if (!this.isEnabled) {
      return;
    }

    try {
      const status = await this.announceMonitorService.checkAnnounceStatus();

      if (status !== null) {
        // Логируем только если статус изменился
        if (status !== this.lastStatus) {
          if (this.lastStatus !== null) {
            this.logger.log(`⚠️ Статус объявления изменился: "${this.lastStatus}" → "${status}"`);
            console.log(`[AnnounceMonitor] ⚠️ Статус изменился: "${this.lastStatus}" → "${status}"`);
            
            // Проверяем, изменился ли статус на "Опубликовано" или "Опубликовано (прием заявок)"
            // Статус может быть просто "Опубликовано" или "Опубликовано (прием заявок)"
            if (status.includes('Опубликовано') && !this.publishedStatusHandled) {
              await this.handleStatusChangeToPublished(status);
              this.publishedStatusHandled = true; // Помечаем, что уже обработали
            } else if (!status.includes('Опубликовано')) {
              // Если статус изменился с "Опубликовано" на другой, сбрасываем флаг
              this.publishedStatusHandled = false;
            }
          } else {
            this.logger.log(`✅ Статус объявления: "${status}"`);
            console.log(`[AnnounceMonitor] ✅ Статус: "${status}"`);
            
            // Если первый раз получили статус "Опубликовано" или "Опубликовано (прием заявок)"
            if (status.includes('Опубликовано') && !this.publishedStatusHandled) {
              await this.handleStatusChangeToPublished(status);
              this.publishedStatusHandled = true; // Помечаем, что уже обработали
            }
          }
          this.lastStatus = status;
        } else {
          // Периодически логируем текущий статус (каждые 60 секунд)
          const now = Date.now();
          if (!this.lastLogTime || now - this.lastLogTime > 60000) {
            this.logger.debug(`Статус объявления: "${status}" (без изменений)`);
            this.lastLogTime = now;
          }
        }
      } else {
        this.logger.warn('Не удалось получить статус объявления');
      }
    } catch (error) {
      this.logger.error(`Ошибка в задаче мониторинга: ${error.message}`);
      if (error.stack) {
        this.logger.debug(error.stack);
      }
    }
  }

  /**
   * Обработка изменения статуса на "Опубликовано (прием заявок)"
   */
  private async handleStatusChangeToPublished(status: string): Promise<void> {
    try {
      const timestamp = new Date().toISOString();
      
      // Получаем announceId
      const announceId = this.announceMonitorService.getAnnounceId();
      this.logger.log(`AnnounceId: "${announceId}"`);
      
      // Формируем запись для файла
      const logEntry = `${timestamp} - Статус изменен на: "${status}", AnnounceId: "${announceId}"\n`;
      
      // Записываем время и announceId в файл
      await fs.appendFile(this.statusChangeLogFile, logEntry, 'utf-8');
      this.logger.log(`✅ Время изменения статуса и announceId записаны в файл: ${this.statusChangeLogFile}`);
      console.log(`[AnnounceMonitor] ✅ Время записано: ${timestamp}, AnnounceId: ${announceId}`);
      
      // Отправляем запрос на основной сервис
      this.logger.log(`Отправка запроса на ${this.mainAppUrl}...`);
      try {
        // Отправляем запрос с announceId
        const requestBody = { number: announceId };
        const response = await axios.post(this.mainAppUrl, requestBody, {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
          },
        });
        
        this.logger.log(`✅ Запрос на /api/applications/start выполнен успешно. Статус: ${response.status}`);
        console.log(`[AnnounceMonitor] ✅ Запрос отправлен на основной сервис, статус: ${response.status}`);
        
        // Логируем ответ если есть
        if (response.data) {
          this.logger.debug(`Ответ от сервиса: ${JSON.stringify(response.data)}`);
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          if (error.response) {
            this.logger.error(`❌ Ошибка при отправке запроса: ${error.response.status} ${error.response.statusText}`);
            this.logger.error(`Ответ: ${JSON.stringify(error.response.data)}`);
          } else if (error.request) {
            this.logger.error(`❌ Не удалось отправить запрос: ${error.message}`);
            this.logger.error(`Возможно, основной сервис не запущен на порту ${this.configService.get<number>('PORT', 3000)}`);
          } else {
            this.logger.error(`❌ Ошибка при подготовке запроса: ${error.message}`);
          }
        } else {
          this.logger.error(`❌ Ошибка при отправке запроса: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Ошибка при обработке изменения статуса: ${(error as Error).message}`);
      if (error.stack) {
        this.logger.debug(error.stack);
      }
    }
  }

  private lastLogTime: number = 0;
}

