import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISessionStorage, SessionData } from './session.interface';
import { RedisService } from '../redis/redis.service';

/**
 * Сервис для хранения сессии в Redis
 * Используется для быстрого доступа к сессии без чтения файла
 */
@Injectable()
export class RedisSessionStorageService implements ISessionStorage {
  private readonly logger = new Logger(RedisSessionStorageService.name);
  private readonly sessionKey = 'session:current';
  private readonly sessionTtl: number; // Время жизни сессии в секундах (по умолчанию 2 минуты)

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
  ) {
    // TTL сессии: 2 минуты по умолчанию (для тестирования)
    // Можно переопределить через SESSION_TTL в .env (в миллисекундах)
    this.sessionTtl = this.configService.get<number>('SESSION_TTL', 2 * 60 * 1000) / 1000; // Конвертируем в секунды (2 минуты = 120 секунд)
    this.logger.log(`TTL сессии установлен: ${this.sessionTtl} секунд (${this.sessionTtl / 60} минут)`);
  }

  async saveSession(sessionData: SessionData): Promise<void> {
    try {
      const dataToSave = {
        ...sessionData,
        expiresAt: sessionData.expiresAt || Date.now() + (this.sessionTtl * 1000),
      };

      // Логируем что сохраняем
      this.logger.debug(`=== Сохранение сессии в Redis ===`);
      this.logger.debug(`isAuthenticated: ${dataToSave.isAuthenticated}`);
      this.logger.debug(`token: ${dataToSave.token ? 'есть' : 'нет'}`);
      this.logger.debug(`cookies: ${dataToSave.cookies?.length || 0}`);
      this.logger.debug(`expiresAt: ${new Date(dataToSave.expiresAt).toISOString()}`);
      this.logger.debug(`TTL: ${this.sessionTtl} секунд (${Math.floor(this.sessionTtl / 60)} минут)`);

      const sessionJson = JSON.stringify(dataToSave);
      await this.redisService.set(this.sessionKey, sessionJson, this.sessionTtl);
      this.logger.log(`✅ Сессия сохранена в Redis (ключ: ${this.sessionKey}, TTL: ${this.sessionTtl} сек)`);
    } catch (error) {
      this.logger.error(`Ошибка сохранения сессии в Redis: ${(error as Error).message}`);
      if (error.stack) {
        this.logger.debug(error.stack);
      }
      throw error;
    }
  }

  async loadSession(): Promise<SessionData | null> {
    try {
      this.logger.log(`Загрузка сессии из Redis (ключ: ${this.sessionKey})...`);
      const sessionJson = await this.redisService.get(this.sessionKey);
      
      if (!sessionJson) {
        this.logger.log('❌ Сессия не найдена в Redis');
        return null;
      }

      this.logger.debug(`Сессия найдена в Redis, размер: ${sessionJson.length} символов`);
      const sessionData: SessionData = JSON.parse(sessionJson);
      
      // Детальное логирование загруженной сессии
      this.logger.log(`=== Данные сессии из Redis ===`);
      this.logger.log(`isAuthenticated: ${sessionData.isAuthenticated}`);
      this.logger.log(`token: ${sessionData.token ? 'есть' : 'нет'} (${sessionData.token ? sessionData.token.substring(0, 20) + '...' : 'null'})`);
      this.logger.log(`cookies: ${sessionData.cookies?.length || 0}`);
      if (sessionData.cookies && sessionData.cookies.length > 0) {
        sessionData.cookies.forEach((cookie, index) => {
          const cookieName = cookie.split('=')[0];
          this.logger.debug(`  Cookie ${index + 1}: ${cookieName}`);
        });
      }
      this.logger.log(`createdAt: ${sessionData.createdAt ? new Date(sessionData.createdAt).toISOString() : 'null'}`);
      this.logger.log(`updatedAt: ${sessionData.updatedAt ? new Date(sessionData.updatedAt).toISOString() : 'null'}`);
      this.logger.log(`expiresAt: ${sessionData.expiresAt ? new Date(sessionData.expiresAt).toISOString() : 'null'}`);
      if (sessionData.expiresAt) {
        const now = Date.now();
        const expiresIn = sessionData.expiresAt - now;
        const expiresInMinutes = Math.floor(expiresIn / 1000 / 60);
        if (expiresIn > 0) {
          this.logger.log(`Истекает через: ${expiresInMinutes} минут (${Math.floor(expiresIn / 1000 / 60 / 60)} часов)`);
        } else {
          this.logger.warn(`⚠️ Сессия истекла ${Math.abs(expiresInMinutes)} минут назад`);
        }
      }
      this.logger.log(`=== Конец данных сессии ===`);

      // Проверяем валидность
      const isValid = this.isSessionValid(sessionData);
      this.logger.log(`Результат проверки валидности: ${isValid ? '✅ ВАЛИДНА' : '❌ НЕВАЛИДНА'}`);
      
      if (!isValid) {
        this.logger.warn(`❌ Сессия истекла или невалидна, очищаем из Redis`);
        await this.clearSession();
        return null;
      }

      this.logger.log('✅ Сессия загружена из Redis и валидна');
      return sessionData;
    } catch (error) {
      this.logger.error(`Ошибка загрузки сессии из Redis: ${(error as Error).message}`);
      if (error.stack) {
        this.logger.debug(error.stack);
      }
      return null;
    }
  }

  async clearSession(): Promise<void> {
    try {
      await this.redisService.delete(this.sessionKey);
      this.logger.debug('Сессия очищена из Redis');
    } catch (error) {
      this.logger.error(`Ошибка очистки сессии из Redis: ${(error as Error).message}`);
    }
  }

  isSessionValid(sessionData: SessionData): boolean {
    this.logger.debug('=== Проверка валидности сессии ===');
    
    // Проверка 1: isAuthenticated
    if (!sessionData.isAuthenticated) {
      this.logger.debug('❌ Сессия невалидна: isAuthenticated=false');
      return false;
    }
    this.logger.debug('✅ isAuthenticated=true');

    // Проверка 2: срок действия
    if (sessionData.expiresAt) {
      const now = Date.now();
      if (now > sessionData.expiresAt) {
        const expiredMinutesAgo = Math.floor((now - sessionData.expiresAt) / 1000 / 60);
        this.logger.debug(`❌ Сессия невалидна: истекла ${expiredMinutesAgo} минут назад`);
        this.logger.debug(`  Текущее время: ${new Date(now).toISOString()}`);
        this.logger.debug(`  Время истечения: ${new Date(sessionData.expiresAt).toISOString()}`);
        return false;
      }
      this.logger.debug(`✅ Срок действия валиден (истекает ${new Date(sessionData.expiresAt).toISOString()})`);
    } else {
      this.logger.debug('⚠️ expiresAt не установлен (сессия без срока истечения)');
    }

    // Проверка 3: наличие токена или cookies
    const hasToken = !!sessionData.token;
    const hasCookies = sessionData.cookies && sessionData.cookies.length > 0;
    
    this.logger.debug(`Токен: ${hasToken ? 'есть' : 'нет'}`);
    this.logger.debug(`Cookies: ${hasCookies ? `есть (${sessionData.cookies?.length || 0})` : 'нет'}`);
    
    if (!hasToken && !hasCookies) {
      this.logger.debug('❌ Сессия невалидна: нет токена и нет cookies');
      return false;
    }
    
    if (hasToken) {
      this.logger.debug('✅ Токен присутствует');
    }
    if (hasCookies) {
      this.logger.debug(`✅ Cookies присутствуют (${sessionData.cookies?.length || 0} шт.)`);
    }

    this.logger.debug('=== Сессия валидна ===');
    return true;
  }
}

