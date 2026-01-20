import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Сервис для работы с Redis
 * Используется для кэширования сертификата и сессии
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private isAvailable = false;
  private readonly fallbackCache = new Map<string, { value: string; expiresAt?: number }>();

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  /**
   * Подключение к Redis
   */
  private async connect(): Promise<void> {
    try {
      const redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
      const redisPort = this.configService.get<number>('REDIS_PORT', 6379);
      const redisPassword = this.configService.get<string>('REDIS_PASSWORD', '');
      const redisDb = this.configService.get<number>('REDIS_DB', 0);

      this.client = new Redis({
        host: redisHost,
        port: redisPort,
        password: redisPassword || undefined,
        db: redisDb,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: true,
      });

      this.client.on('error', (error) => {
        this.logger.warn(`Redis ошибка: ${error.message}`);
        this.isAvailable = false;
      });

      this.client.on('connect', () => {
        this.logger.log('Подключение к Redis...');
      });

      this.client.on('ready', () => {
        this.isAvailable = true;
        this.logger.log('✅ Redis подключен и готов к работе');
      });

      await this.client.connect();
    } catch (error) {
      this.logger.warn(`Redis недоступен, используется in-memory кэш: ${(error as Error).message}`);
      this.isAvailable = false;
      this.client = null;
    }
  }

  /**
   * Отключение от Redis
   */
  private async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isAvailable = false;
    }
  }

  /**
   * Проверка доступности Redis
   */
  isRedisAvailable(): boolean {
    return this.isAvailable && this.client !== null;
  }

  /**
   * Установить значение с TTL
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (this.isRedisAvailable() && this.client) {
        if (ttlSeconds) {
          await this.client.setex(key, ttlSeconds, value);
        } else {
          await this.client.set(key, value);
        }
        this.logger.debug(`Redis SET: ${key} (TTL: ${ttlSeconds || 'без ограничения'})`);
      } else {
        // Fallback: in-memory кэш
        const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
        this.fallbackCache.set(key, { value, expiresAt });
        this.logger.debug(`In-memory SET: ${key} (TTL: ${ttlSeconds || 'без ограничения'})`);
      }
    } catch (error) {
      this.logger.warn(`Ошибка установки значения в Redis, используется in-memory: ${(error as Error).message}`);
      // Fallback: in-memory кэш
      const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
      this.fallbackCache.set(key, { value, expiresAt });
    }
  }

  /**
   * Получить значение
   */
  async get(key: string): Promise<string | null> {
    try {
      if (this.isRedisAvailable() && this.client) {
        const value = await this.client.get(key);
        if (value) {
          this.logger.debug(`Redis GET: ${key} (найдено)`);
        } else {
          this.logger.debug(`Redis GET: ${key} (не найдено)`);
        }
        return value;
      } else {
        // Fallback: in-memory кэш
        const cached = this.fallbackCache.get(key);
        if (cached) {
          // Проверяем срок действия
          if (cached.expiresAt && Date.now() > cached.expiresAt) {
            this.fallbackCache.delete(key);
            this.logger.debug(`In-memory GET: ${key} (истек)`);
            return null;
          }
          this.logger.debug(`In-memory GET: ${key} (найдено)`);
          return cached.value;
        }
        this.logger.debug(`In-memory GET: ${key} (не найдено)`);
        return null;
      }
    } catch (error) {
      this.logger.warn(`Ошибка получения значения из Redis, используется in-memory: ${(error as Error).message}`);
      // Fallback: in-memory кэш
      const cached = this.fallbackCache.get(key);
      if (cached) {
        if (cached.expiresAt && Date.now() > cached.expiresAt) {
          this.fallbackCache.delete(key);
          return null;
        }
        return cached.value;
      }
      return null;
    }
  }

  /**
   * Удалить значение
   */
  async delete(key: string): Promise<void> {
    try {
      if (this.isRedisAvailable() && this.client) {
        await this.client.del(key);
        this.logger.debug(`Redis DEL: ${key}`);
      } else {
        // Fallback: in-memory кэш
        this.fallbackCache.delete(key);
        this.logger.debug(`In-memory DEL: ${key}`);
      }
    } catch (error) {
      this.logger.warn(`Ошибка удаления значения из Redis: ${(error as Error).message}`);
      this.fallbackCache.delete(key);
    }
  }

  /**
   * Проверить существование ключа
   */
  async exists(key: string): Promise<boolean> {
    try {
      if (this.isRedisAvailable() && this.client) {
        const result = await this.client.exists(key);
        return result === 1;
      } else {
        // Fallback: in-memory кэш
        const cached = this.fallbackCache.get(key);
        if (cached) {
          if (cached.expiresAt && Date.now() > cached.expiresAt) {
            this.fallbackCache.delete(key);
            return false;
          }
          return true;
        }
        return false;
      }
    } catch (error) {
      this.logger.warn(`Ошибка проверки существования ключа в Redis: ${(error as Error).message}`);
      const cached = this.fallbackCache.get(key);
      return cached !== undefined && (!cached.expiresAt || Date.now() <= cached.expiresAt);
    }
  }

  /**
   * Установить TTL для существующего ключа
   */
  async expire(key: string, ttlSeconds: number): Promise<void> {
    try {
      if (this.isRedisAvailable() && this.client) {
        await this.client.expire(key, ttlSeconds);
        this.logger.debug(`Redis EXPIRE: ${key} (${ttlSeconds}s)`);
      } else {
        // Fallback: in-memory кэш
        const cached = this.fallbackCache.get(key);
        if (cached) {
          cached.expiresAt = Date.now() + ttlSeconds * 1000;
          this.logger.debug(`In-memory EXPIRE: ${key} (${ttlSeconds}s)`);
        }
      }
    } catch (error) {
      this.logger.warn(`Ошибка установки TTL в Redis: ${(error as Error).message}`);
    }
  }
}

