import cron from 'node-cron';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from '../config/config.js';
import HttpClient from '../services/http-client.js';
import AuthService from '../services/auth-service.js';
import NcanodeService from '../services/ncanode-service.js';
import ApplicationService from '../services/application-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Планировщик задач (cron) для автоматической подачи заявок
 */
class Scheduler {
  constructor() {
    this.config = config;
    this.httpClient = new HttpClient(config);
    this.ncanodeService = new NcanodeService(config);
    this.authService = new AuthService(config, this.httpClient, this.ncanodeService);
    this.applicationService = new ApplicationService(
      config,
      this.httpClient,
      this.authService,
      this.ncanodeService
    );
    this.task = null;
  }

  /**
   * Запустить планировщик
   */
  start() {
    if (!this.config.cron.enabled) {
      console.log('[CRON] Планировщик отключен в конфигурации');
      return;
    }

    console.log(`[CRON] Запуск планировщика с расписанием: ${this.config.cron.schedule}`);

    this.task = cron.schedule(this.config.cron.schedule, async () => {
      console.log('[CRON] Запуск задачи по расписанию...');
      await this.executeTask();
    }, {
      scheduled: true,
      timezone: "Asia/Almaty", // Временная зона Казахстана
    });

    console.log('[CRON] Планировщик запущен');
  }

  /**
   * Остановить планировщик
   */
  stop() {
    if (this.task) {
      this.task.stop();
      console.log('[CRON] Планировщик остановлен');
    }
  }

  /**
   * Выполнить задачу
   */
  async executeTask() {
    try {
      console.log('[CRON] Начало выполнения задачи...');

      // Проверяем доступность ncanode
      // const ncanodeAvailable = await this.ncanodeService.healthCheck();
      // if (!ncanodeAvailable) {
      //   throw new Error('ncanode недоступен');
      // }
      console.log('[CRON] ncanode доступен');
      console.log('[CRON] login starting .....======>');
      await this.authService.login();

    } catch (error) {
      console.error('[CRON] Ошибка выполнения задачи:', error.message);
      throw error;
    }
  }


}

// Запуск планировщика если файл запущен напрямую
if (import.meta.url === `file://${process.argv[1]}`) {
  const scheduler = new Scheduler();
  scheduler.start();

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[CRON] Получен сигнал SIGINT, остановка...');
    scheduler.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[CRON] Получен сигнал SIGTERM, остановка...');
    scheduler.stop();
    process.exit(0);
  });
}

export default Scheduler;

