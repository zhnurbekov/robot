import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '../http/http.service';
import { AuthService } from '../auth/auth.service';
import { PortalService } from '../portal/portal.service';
import { ApplicationService } from '../application/application.service';
import { RedisService } from '../redis/redis.service';
import { TelegramService } from '../telegram/telegram.service';
import * as cheerio from 'cheerio';
import axios from 'axios';

export interface FavoriteAnnouncement {
  number: string; // Номер объявления (например, "15880798-1")
  organizer: string; // Организатор
  titleRu: string; // Название объявления на русском
  titleKz: string; // Название объявления на казахском
  procurementMethod: string; // Способ закупки
  procurementType: string; // Вид предмета закупки
  startDate: string; // Дата начала приема заявок
  endDate: string; // Дата окончания приема заявок
  lotsCount: string; // Количество лотов
  totalAmount: string; // Сумма объявления
  status: string; // Статус
  announceId: string; // ID объявления (извлекается из number или ссылки)
  url: string; // URL объявления
}

@Injectable()
export class AnnounceMonitorService {
  private readonly logger = new Logger(AnnounceMonitorService.name);

  private readonly mainAppUrl: string;
  private readonly redisKeyPrefix = 'announcement:processing:'; // Префикс для ключей Redis
  private readonly redisTtlHours = 24; // TTL в часах (24 часа = 86400 секунд)

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
    @Inject(forwardRef(() => AuthService))
    private authService: AuthService,
    private portalService: PortalService,
    @Inject(forwardRef(() => ApplicationService))
    private applicationService: ApplicationService,
    private redisService: RedisService,
    private telegramService: TelegramService,
  ) {
    // URL основного приложения для вызова API start
    const mainAppPort = this.configService.get<number>('PORT', 3000);
    this.mainAppUrl = `http://localhost:${mainAppPort}/api/applications/start`;
  }

  /**
   * Получить список избранных объявлений с портала
   * @returns Массив объектов с данными объявлений из таблицы избранного
   */
  async getFavorites(): Promise<FavoriteAnnouncement[]> {
    const taskId = 'getFavorites';
    this.logger.log(`[${taskId}] Получение списка избранных объявлений...`);

    try {
      // Проверяем авторизацию
      await this.authService.login();

      // Отправляем запрос на страницу избранного
      const response = await this.portalService.request({
        url: '/ru/favorites',
        method: 'GET',
        additionalHeaders: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.success || !response.data || typeof response.data !== 'string') {
        throw new Error('Не удалось получить HTML страницы избранного');
      }

      const html = response.data as string;
      const favorites = this.parseFavoritesTable(html);

      this.logger.log(`[${taskId}] Получено избранных объявлений: ${favorites.length}`);
      return favorites;
    } catch (error) {
      this.logger.error(`[${taskId}] Ошибка при получении избранных объявлений: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Парсинг таблицы избранных объявлений из HTML
   * @param html - HTML содержимое страницы
   * @returns Массив объектов с данными объявлений
   */
  private parseFavoritesTable(html: string): FavoriteAnnouncement[] {
    const $ = cheerio.load(html);
    const favorites: FavoriteAnnouncement[] = [];

    // Находим таблицу с классом table-bordered
    const table = $('table.table-bordered');
    
    if (table.length === 0) {
      this.logger.warn('Таблица избранного не найдена на странице');
      return favorites;
    }

    // Пропускаем заголовок (первая строка <tr> с <th>)
    const rows = table.find('tr').filter((index, element) => {
      return $(element).find('th').length === 0; // Пропускаем строки с заголовками
    });

    rows.each((index, element) => {
      const $row = $(element);
      const cells = $row.find('td');

      if (cells.length < 10) {
        this.logger.warn(`Строка ${index + 1} содержит недостаточно ячеек (${cells.length} вместо 10)`);
        return;
      }

      try {
        // Извлекаем номер объявления
        const number = $(cells[0]).text().trim();
        
        // Извлекаем ID объявления из номера (например, "15880798-1" -> "15880798")
        const announceId = number.split('-')[0];

        // Организатор
        const organizer = $(cells[1]).text().trim();

        // Название объявления (может содержать русский и казахский текст)
        const nameCell = $(cells[2]);
        const titleLink = nameCell.find('a');
        const titleDivs = titleLink.find('div');
        
        let titleRu = '';
        let titleKz = '';
        if (titleDivs.length >= 2) {
          titleRu = $(titleDivs[0]).text().trim();
          titleKz = $(titleDivs[1]).text().trim();
        } else if (titleDivs.length === 1) {
          titleRu = $(titleDivs[0]).text().trim();
        } else {
          titleRu = titleLink.text().trim();
        }

        // URL объявления
        const url = titleLink.attr('href') || '';

        // Способ закупки
        const procurementMethod = $(cells[3]).text().trim();

        // Вид предмета закупки
        const procurementType = $(cells[4]).text().trim();

        // Дата начала приема заявок
        const startDate = $(cells[5]).text().trim();

        // Дата окончания приема заявок
        const endDate = $(cells[6]).text().trim();

        // Количество лотов
        const lotsCount = $(cells[7]).text().trim();

        // Сумма объявления
        const totalAmount = $(cells[8]).text().trim();

        // Статус
        const status = $(cells[9]).text().trim();

        favorites.push({
          number,
          organizer,
          titleRu,
          titleKz,
          procurementMethod,
          procurementType,
          startDate,
          endDate,
          lotsCount,
          totalAmount,
          status,
          announceId,
          url,
        });
      } catch (error) {
        this.logger.error(`Ошибка при парсинге строки ${index + 1}: ${(error as Error).message}`);
      }
    });

    return favorites;
  }

  /**
   * Мониторинг статусов избранных объявлений
   * Проверяет статусы и вызывает API start для объявлений со статусом "Опубликовано (прием заявок)"
   */
  async monitorFavoritesStatus(): Promise<void> {
    const taskId = 'monitorFavoritesStatus';
    this.logger.log(`[${taskId}] Начало мониторинга статусов избранных объявлений...`);

    try {
      // Получаем список избранных объявлений
      const favorites = await this.getFavorites();

      if (favorites.length === 0) {
        this.logger.log(`[${taskId}] Нет избранных объявлений для мониторинга`);
        return;
      }

      this.logger.log(`[${taskId}] Найдено избранных объявлений: ${favorites.length}`);

      // Проверяем каждое объявление
      for (const favorite of favorites) {
        const status = favorite.status.trim();
        const announceId = favorite.announceId;

        // Проверяем статус "Опубликовано (прием заявок)"
        if (status === 'Опубликовано (прием заявок)' || (status.includes('Опубликовано') && status.includes('прием заявок'))) {
          // Проверяем в Redis, не обрабатывается ли уже это объявление
          const redisKey = `${this.redisKeyPrefix}${announceId}`;
          const isProcessing = await this.redisService.exists(redisKey);
          
          if (!isProcessing) {
            this.logger.log(`[${taskId}] Найдено объявление со статусом "Опубликовано (прием заявок)": ${announceId} (${favorite.number})`);
            
            // Время начала обработки
            const startTime = new Date();
            
            try {
              // Записываем в Redis перед началом обработки
              const timestamp = startTime.toISOString();
              await this.redisService.set(redisKey, timestamp, this.redisTtlHours * 3600);
              this.logger.log(`[${taskId}] Объявление ${announceId} записано в Redis для предотвращения повторной обработки`);
              
              // Вызываем API start
              await this.callStartApi(announceId);
              
              // Время окончания обработки
              const endTime = new Date();
              const durationMs = endTime.getTime() - startTime.getTime();
              
              this.logger.log(`[${taskId}] Объявление ${announceId} успешно обработано за ${durationMs} мс`);
              
              // Отправляем уведомление в Telegram об успешной обработке
              await this.telegramService.sendApplicationNotification(
                announceId,
                'success',
                startTime,
                endTime,
                durationMs,
              );
            } catch (error) {
              // Время окончания обработки (с ошибкой)
              const endTime = new Date();
              const durationMs = endTime.getTime() - startTime.getTime();
              const errorMessage = (error as Error).message;
              
              this.logger.error(`[${taskId}] Ошибка при вызове API start для объявления ${announceId}: ${errorMessage}`);
              
              // Отправляем уведомление в Telegram об ошибке
              await this.telegramService.sendApplicationNotification(
                announceId,
                'error',
                startTime,
                endTime,
                durationMs,
                errorMessage,
              );
              
              // При ошибке можно удалить ключ из Redis, чтобы попробовать снова при следующем запуске
              // Или оставить ключ, чтобы не повторять обработку сломанных объявлений
              // await this.redisService.delete(redisKey);
            }
          } else {
            const processingTime = await this.redisService.get(redisKey);
            this.logger.debug(`[${taskId}] Объявление ${announceId} уже обрабатывается (записано в Redis: ${processingTime}), пропускаем`);
          }
        } else {
          // Если статус изменился с "Опубликовано (прием заявок)" на другой, удаляем из Redis
          const redisKey = `${this.redisKeyPrefix}${announceId}`;
          const exists = await this.redisService.exists(redisKey);
          if (exists) {
            await this.redisService.delete(redisKey);
            this.logger.log(`[${taskId}] Статус объявления ${announceId} изменился на "${status}", удаляем из Redis`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`[${taskId}] Ошибка при мониторинге статусов: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Вызов API start для объявления
   * @param announceId - ID объявления
   */
  private async callStartApi(announceId: string): Promise<void> {
    const taskId = `callStartApi-${announceId}`;
    this.logger.log(`[${taskId}] Вызов API start для объявления ${announceId}...`);

    try {
      // Вызываем напрямую ApplicationService
      await this.applicationService.submitApplication(announceId);

      this.logger.log(`[${taskId}] ✅ API start успешно выполнен для объявления ${announceId}`);

      // После успешного запуска подачи заявки — удаляем объявление из избранного
      await this.deleteFromFavorites(announceId);
    } catch (error) {
      this.logger.error(`[${taskId}] ❌ Ошибка при вызове API start: ${(error as Error).message}`);
      
      // Если прямой вызов не работает, пробуем через HTTP
      try {
        this.logger.log(`[${taskId}] Попытка вызова через HTTP API...`);
        const response = await axios.post(this.mainAppUrl, { number: announceId }, {
          timeout: 300000, // 5 минут таймаут
          headers: {
            'Content-Type': 'application/json',
          },
        });

        this.logger.log(`[${taskId}] ✅ HTTP запрос выполнен успешно. Статус: ${response.status}`);

        // После успешного HTTP-вызова также удаляем объявление из избранного
        await this.deleteFromFavorites(announceId);
      } catch (httpError) {
        this.logger.error(`[${taskId}] ❌ Ошибка при HTTP запросе: ${(httpError as Error).message}`);
        throw error; // Бросаем исходную ошибку
      }
    }
  }

  /**
   * Удалить объявление из избранного на портале
   * Делаем GET-запрос на /ru/favorites/fav/?action=delete&id={announceId}
   * Логируем время отправки запроса и длительность выполнения
   */
  private async deleteFromFavorites(announceId: string): Promise<void> {
    const taskId = `deleteFromFavorites-${announceId}`;
    const url = `/ru/favorites/fav/?action=delete&id=${announceId}`;

    // Время отправки запроса
    const sendTime = new Date();
    const sendTimeIso = sendTime.toISOString();

    this.logger.log(`[${taskId}] Отправка запроса на удаление из избранного в ${sendTimeIso}. URL: ${url}`);

    const startTime = Date.now();

    try {
      // Используем PortalService, чтобы сохранить сессию/куки
      const response = await this.portalService.request({
        url,
        method: 'GET',
      });

      const durationMs = Date.now() - startTime;

      if (!response.success) {
        this.logger.warn(`[${taskId}] Запрос удаления из избранного завершился неуспешно. Время выполнения: ${durationMs} мс`);
        return;
      }

      this.logger.log(
        `[${taskId}] ✅ Объявление ${announceId} удалено из избранного. Время отправки: ${sendTimeIso}, время выполнения: ${durationMs} мс`,
      );
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.logger.error(
        `[${taskId}] ❌ Ошибка при удалении из избранного (ID=${announceId}). Время отправки: ${sendTimeIso}, время выполнения: ${durationMs} мс. Ошибка: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Сброс списка обработанных объявлений в Redis (для тестирования или перезапуска)
   * Удаляет все ключи с префиксом announcement:processing:
   */
  async resetProcessedAnnouncements(): Promise<void> {
    // Примечание: RedisService не имеет метода для удаления по паттерну
    // Можно добавить такой метод или удалять ключи вручную
    this.logger.log('Для очистки Redis используйте команду: redis-cli KEYS "announcement:processing:*" | xargs redis-cli DEL');
    this.logger.warn('Метод resetProcessedAnnouncements() требует реализации удаления по паттерну в RedisService');
  }

  /**
   * Удалить конкретное объявление из Redis (для тестирования)
   */
  async removeFromRedis(announceId: string): Promise<void> {
    const redisKey = `${this.redisKeyPrefix}${announceId}`;
    await this.redisService.delete(redisKey);
    this.logger.log(`Объявление ${announceId} удалено из Redis`);
  }
}

