import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

const HTTP_REQUESTS_LOG_KEY = 'http:requests:log';
const MAX_LIST_LEN = 50000;

export interface PushErrorOptions {
  desc?: string;
  action?: string;
  lotId?: string;
}

/**
 * Отправка любой ошибки в Redis; крон http-log-cron перенесёт в БД.
 * Не используется в favorites-cron (там пишут напрямую в БД).
 */
@Injectable()
export class ErrorLogService {
  private readonly logger = new Logger(ErrorLogService.name);
  private readonly enabled: boolean;

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
  ) {
    this.enabled = this.configService.get<string>('LOG_ERRORS_TO_REDIS', 'true') !== 'false';
  }

  /**
   * Отправить ошибку в Redis (далее попадёт в таблицу logs через http-log-cron).
   */
  async pushError(source: string, errorMessage: string, options?: PushErrorOptions): Promise<void> {
    if (!this.enabled || !this.redisService.isRedisAvailable()) return;
    try {
      const payload = {
        url: '',
        method: '',
        success: false,
        errorMessage: (errorMessage || 'Неизвестная ошибка').slice(0, 256),
        durationMs: 0,
        timestamp: new Date().toISOString(),
        source,
        context: 'error',
        desc: options?.desc ?? 'Ошибка',
        action: options?.action ?? 'error',
        lotId: options?.lotId ?? undefined,
      };
      await this.redisService.rpush(HTTP_REQUESTS_LOG_KEY, JSON.stringify(payload));
      const len = await this.redisService.llen(HTTP_REQUESTS_LOG_KEY);
      if (len > MAX_LIST_LEN) {
        await this.redisService.ltrim(HTTP_REQUESTS_LOG_KEY, -MAX_LIST_LEN, -1);
      }
    } catch (err) {
      this.logger.warn(`Не удалось отправить ошибку в Redis: ${(err as Error).message}`);
    }
  }
}
