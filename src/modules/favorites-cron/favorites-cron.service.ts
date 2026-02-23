import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as cheerio from 'cheerio';
import { AuthService } from '../auth/auth.service';
import { PortalService } from '../portal/portal.service';
import { HttpRequestLog } from '../http-log-cron/entities/http-request-log.entity';

interface FavoriteItem {
  announceId: string;
  status: string;
  number: string;
}

@Injectable()
export class FavoritesCronService {
  private readonly logger = new Logger(FavoritesCronService.name);

  constructor(
    private configService: ConfigService,
    private authService: AuthService,
    private portalService: PortalService,
    @InjectRepository(HttpRequestLog)
    private readonly logRepo: Repository<HttpRequestLog>,
  ) {}

  /**
   * Раз в секунду: запрос /ru/favorites, сразу запись всех объявлений в БД.
   */
  @Interval(1000)
  async syncFavoritesAndLogStatusChanges(): Promise<void> {
    const enabled = this.configService.get<string>('FAVORITES_CRON_ENABLED', 'true') === 'true';
    if (!enabled) return;

    try {
      await this.authService.login();
      const current = await this.fetchFavorites();

      const toLog: HttpRequestLog[] = [];
      for (const item of current) {
        const log = new HttpRequestLog();
        log.desc = 'Избранное';
        log.action = 'favorites_sync_cron';
        log.status = item.status;
        const parsed = parseInt(item.announceId, 10);
        log.lotId = Number.isNaN(parsed) ? null : parsed;
        log.createdAt = new Date();
        toLog.push(log);
      }

      if (toLog.length > 0) {
        await this.logRepo.insert(toLog);
        this.logger.log(`Записано в БД избранного: ${toLog.length}`);
      }
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      this.logger.error(`Ошибка крона избранного: ${message}`);
      try {
        await this.writeErrorToLog(message);
      } catch (logErr) {
        this.logger.error(`Не удалось записать ошибку в лог БД: ${(logErr as Error).message}`);
      }
    }
  }

  /** Записать ошибку (в т.ч. авторизации) в таблицу logs */
  private async writeErrorToLog(errorMessage: string): Promise<void> {
    const status = (errorMessage || 'Неизвестная ошибка').slice(0, 256);
    const log = this.logRepo.create({
      desc: 'Ошибка авторизации / крона избранного',
      action: 'auth_error',
      status,
      lotId: null,
      createdAt: new Date(),
    });
    await this.logRepo.save(log);
    this.logger.log('Ошибка авторизации записана в таблицу logs');
  }

  /**
   * Запрос /ru/favorites и парсинг таблицы (та же логика, что в announce-monitor).
   */
  private async fetchFavorites(): Promise<FavoriteItem[]> {
    const response = await this.portalService.request({
      url: '/ru/favorites',
      method: 'GET',
      additionalHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const html = typeof response.data === 'string' ? response.data : '';
    if (!response.success || !html) {
      throw new Error('Не удалось получить страницу избранного');
    }

    const isLoginPage =
      response.redirectedToAuth ||
      html.includes('<title>Авторизация</title>') ||
      html.includes('/user/login') ||
      html.includes('window.current_method = "login"');

    if (isLoginPage) {
      await this.authService.login(true);
      const retryResponse = await this.portalService.request({
        url: '/ru/favorites',
        method: 'GET',
        additionalHeaders: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const retryHtml = typeof retryResponse.data === 'string' ? retryResponse.data : '';
      const stillLoginPage =
        retryResponse.redirectedToAuth ||
        retryHtml.includes('<title>Авторизация</title>') ||
        retryHtml.includes('/user/login') ||
        retryHtml.includes('window.current_method = "login"');
      if (stillLoginPage) {
        throw new Error('Не удалось авторизоваться для доступа к избранному (после переавторизации снова страница логина)');
      }
      return this.parseFavoritesTable(retryHtml);
    }

    return this.parseFavoritesTable(html);
  }

  private parseFavoritesTable(html: string): FavoriteItem[] {
    const $ = cheerio.load(html);
    const items: FavoriteItem[] = [];
    const table = $('table.table-bordered');
    if (table.length === 0) return items;

    const rows = table.find('tr').filter((_, el) => $(el).find('th').length === 0);
    rows.each((index, element) => {
      const cells = $(element).find('td');
      if (cells.length < 10) return;
      const number = $(cells[0]).text().trim();
      const announceId = number.split('-')[0];
      const status = $(cells[9]).text().trim();
      items.push({ announceId, status, number });
    });
    return items;
  }
}
