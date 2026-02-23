import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { HttpRequestLog } from './entities/http-request-log.entity';

const HTTP_REQUESTS_LOG_KEY = 'http:requests:log';
const BATCH_SIZE = 500;

@Injectable()
export class HttpLogCronService {
  private readonly logger = new Logger(HttpLogCronService.name);

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
    @InjectRepository(HttpRequestLog)
    private readonly httpRequestLogRepo: Repository<HttpRequestLog>,
  ) {}

  /**
   * Крон: забирает записи из Redis (http:requests:log) и записывает в PostgreSQL.
   * Расписание по умолчанию — каждую минуту.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async syncHttpLogsFromRedis(): Promise<void> {
    const enabled = this.configService.get<string>('HTTP_LOG_CRON_ENABLED', 'true') === 'true';
    if (!enabled) return;

    if (!this.redisService.isRedisAvailable()) {
      this.logger.debug('Redis недоступен, пропуск синхронизации HTTP-логов');
      return;
    }

    try {
      const count = await this.processBatch();
      if (count > 0) {
        this.logger.log(`Перенесено записей из Redis в БД: ${count}`);
      }
    } catch (error) {
      this.logger.error(`Ошибка синхронизации HTTP-логов: ${(error as Error).message}`);
    }
  }

  /**
   * Забрать одну порцию из Redis и записать в БД. Возвращает количество перенесённых записей.
   */
  async processBatch(): Promise<number> {
    const rawList = await this.redisService.lrange(HTTP_REQUESTS_LOG_KEY, 0, BATCH_SIZE - 1);
    if (rawList.length === 0) return 0;

    const entities: HttpRequestLog[] = [];
    for (const raw of rawList) {
      try {
        const entry = JSON.parse(raw) as Record<string, unknown>;
        const log = new HttpRequestLog();
        log.desc = entry.desc != null ? String(entry.desc) : null;
        log.action = entry.action != null ? String(entry.action) : null;
        const statusFromError = entry.success === false && entry.errorMessage != null
          ? String(entry.errorMessage).slice(0, 256)
          : null;
        log.status = statusFromError ?? (Boolean(entry.success) ? 'success' : 'error');
        if (entry.lotId != null) {
          const parsed = parseInt(String(entry.lotId), 10);
          log.lotId = Number.isNaN(parsed) ? null : parsed;
        } else {
          log.lotId = null;
        }
        log.createdAt = entry.timestamp ? new Date(String(entry.timestamp)) : new Date();
        entities.push(log);
      } catch (parseErr) {
        this.logger.warn(`Не удалось разобрать запись из Redis: ${(parseErr as Error).message}`);
      }
    }

    if (entities.length === 0) {
      // Все записи битые — удаляем их из Redis, чтобы не зацикливаться
      await this.redisService.ltrim(HTTP_REQUESTS_LOG_KEY, rawList.length, -1);
      return 0;
    }

    await this.httpRequestLogRepo.insert(entities);
    // Удаляем из Redis ровно столько элементов, сколько прочитали (включая битые)
    await this.redisService.ltrim(HTTP_REQUESTS_LOG_KEY, rawList.length, -1);
    return entities.length;
  }
}
