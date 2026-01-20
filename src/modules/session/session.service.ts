import { Injectable, Logger, Inject } from '@nestjs/common';
import { ISessionStorage, SessionData } from './session.interface';
import { HttpService } from '../http/http.service';
import { globalSessionState } from '../auth/global-session-state';

/**
 * Сервис для управления сессией
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private currentSession: SessionData | null = null;
  // Глобальная переменная в памяти для быстрого доступа (кэш)
  private sessionCache: SessionData | null = null;
  private lastCacheUpdate: number = 0;
  private readonly cacheUpdateInterval: number = 5000; // Обновляем кэш каждые 5 секунд

  constructor(
    @Inject('ISessionStorage') private sessionStorage: ISessionStorage,
    private httpService: HttpService,
  ) {}

  /**
   * Инициализация: загрузка сессии при старте
   */
  async initialize(): Promise<void> {
    this.logger.log('Инициализация сессии...');
    // Загружаем из файла при старте
    this.currentSession = await this.sessionStorage.loadSession();
    this.sessionCache = this.currentSession;
    this.lastCacheUpdate = Date.now();
    
    if (this.currentSession) {
      this.logger.log(`Сессия загружена из хранилища: isAuthenticated=${this.currentSession.isAuthenticated}, cookies=${this.currentSession.cookies?.length || 0}, token=${!!this.currentSession.token}`);
      // Проверяем валидность сессии
      const isValid = await this.isValid();
      if (isValid) {
        this.logger.log('Сессия валидна, восстанавливаем cookies...');
        // Восстанавливаем cookies в HTTP клиент
        await this.restoreCookies();
        // Обновляем глобальное состояние
        globalSessionState.isAuthenticated = this.currentSession.isAuthenticated || false;
        globalSessionState.isValid = true;
        globalSessionState.cookies = this.currentSession.cookies || [];
        globalSessionState.sessionToken = this.currentSession.token || null;
      } else {
        this.logger.log(`Сессия невалидна, требуется новая авторизация. isAuthenticated=${this.currentSession.isAuthenticated}, cookies=${this.currentSession.cookies?.length || 0}, token=${!!this.currentSession.token}`);
        this.currentSession = null;
        this.sessionCache = null;
        // Обновляем глобальное состояние
        globalSessionState.isAuthenticated = false;
        globalSessionState.isValid = false;
        globalSessionState.cookies = [];
      }
    } else {
      this.logger.log('Сессия не найдена, требуется авторизация');
      // Обновляем глобальное состояние
      globalSessionState.isAuthenticated = false;
      globalSessionState.isValid = false;
      globalSessionState.cookies = [];
    }
    
    // Включаем автоматическое сохранение cookies для сохранения сессии между запросами
    // Используем debounce для уменьшения количества записей в файл
    this.httpService.setOnCookiesUpdatedCallback(() => this.saveCookiesDebounced());
    this.logger.log('Автоматическое сохранение cookies включено - сессия будет сохраняться в памяти и файле');
  }

  /**
   * Сохранить сессию
   */
  async saveSession(sessionData: Partial<SessionData>): Promise<void> {
    this.currentSession = {
      createdAt: this.currentSession?.createdAt || Date.now(),
      isAuthenticated: true,
      ...this.currentSession,
      ...sessionData,
    };
    
    // Обновляем кэш в памяти сразу (быстро)
    this.sessionCache = { ...this.currentSession };
    this.lastCacheUpdate = Date.now();

    // Сохраняем в файл (для персистентности между перезапусками)
    await this.sessionStorage.saveSession(this.currentSession);
    this.logger.debug('Сессия сохранена в память и файл');
  }

  /**
   * Получить текущую сессию (из кэша в памяти - быстро)
   */
  getSession(): SessionData | null {
    // Используем кэш в памяти для быстрого доступа
    return this.sessionCache || this.currentSession;
  }
  
  /**
   * Сохранение cookies с debounce для уменьшения количества записей в файл
   */
  private saveCookiesDebounceTimer: NodeJS.Timeout | null = null;
  
  private async saveCookiesDebounced(): Promise<void> {
    // Отменяем предыдущий таймер
    if (this.saveCookiesDebounceTimer) {
      clearTimeout(this.saveCookiesDebounceTimer);
    }
    
    // Обновляем кэш в памяти сразу (быстро)
    try {
      const cookies = await this.httpService.getCookiesAsArray();
      if (this.sessionCache) {
        this.sessionCache.cookies = cookies;
        this.sessionCache.updatedAt = Date.now();
      } else if (this.currentSession) {
        this.currentSession.cookies = cookies;
        this.currentSession.updatedAt = Date.now();
        this.sessionCache = { ...this.currentSession };
      }
      this.lastCacheUpdate = Date.now();
    } catch (error) {
      this.logger.warn(`Ошибка обновления кэша cookies: ${(error as Error).message}`);
    }
    
    // Сохраняем в файл с задержкой (debounce) - только если прошло достаточно времени
    this.saveCookiesDebounceTimer = setTimeout(async () => {
      await this.saveCookies();
    }, 2000); // Сохраняем в файл через 2 секунды после последнего обновления
    
    // Обновляем глобальное состояние
    try {
      const cookies = await this.httpService.getCookiesAsArray();
      globalSessionState.cookies = cookies;
    } catch (error) {
      this.logger.warn(`Ошибка обновления глобального состояния cookies: ${(error as Error).message}`);
    }
  }

  /**
   * Проверить, валидна ли текущая сессия (быстрая проверка в памяти)
   */
  async isValid(): Promise<boolean> {
    // Используем кэш для быстрой проверки
    const session = this.sessionCache || this.currentSession;
    if (!session) {
      this.logger.debug('isValid(): сессия отсутствует');
      return false;
    }

    // Быстрая локальная проверка без обращения к файлу
    if (!session.isAuthenticated) {
      this.logger.debug(`isValid(): isAuthenticated=false, cookies=${session.cookies?.length || 0}, token=${!!session.token}`);
      return false;
    }

    // Проверяем срок действия
    if (session.expiresAt && Date.now() > session.expiresAt) {
      this.logger.log('Сессия истекла, очищаем');
      await this.clearSession();
      return false;
    }

    // Проверяем наличие токена или cookies
    if (!session.token && (!session.cookies || session.cookies.length === 0)) {
      this.logger.debug(`isValid(): нет токена и cookies (token=${!!session.token}, cookies=${session.cookies?.length || 0})`);
      return false;
    }

    this.logger.debug(`isValid(): сессия валидна (isAuthenticated=true, cookies=${session.cookies?.length || 0}, token=${!!session.token})`);
    return true;
  }

  /**
   * Очистить сессию
   */
  async clearSession(): Promise<void> {
    this.currentSession = null;
    this.sessionCache = null;
    this.lastCacheUpdate = 0;
    await this.sessionStorage.clearSession();
    await this.httpService.clearCookies();
    // Обновляем глобальное состояние
    globalSessionState.isAuthenticated = false;
    globalSessionState.sessionToken = null;
    globalSessionState.isValid = false;
    globalSessionState.cookies = [];
    globalSessionState.lastAuthTime = null;
    this.logger.log('Сессия очищена из памяти и файла');
  }

  /**
   * Восстановить cookies из сессии в HTTP клиент
   * Cookies содержат сессионный ID, который будет использоваться для последующих запросов
   */
  private async restoreCookies(): Promise<void> {
    if (!this.currentSession?.cookies || this.currentSession.cookies.length === 0) {
      this.logger.log('Нет cookies для восстановления');
      return;
    }

    try {
      await this.httpService.restoreCookies(this.currentSession.cookies);
      this.logger.log(`Восстановлено ${this.currentSession.cookies.length} cookies из сессии`);
      
      // Логируем сессионные cookies
      const sessionCookies = this.currentSession.cookies.filter(c => 
        c.toLowerCase().includes('session') || 
        c.toLowerCase().includes('sid') ||
        c.toLowerCase().includes('jsessionid')
      );
      if (sessionCookies.length > 0) {
        this.logger.log(`Восстановлены сессионные cookies: ${sessionCookies.length}`);
        console.log(`[SESSION] Восстановлены сессионные cookies:`, sessionCookies);
      }
    } catch (error) {
      this.logger.error(`Ошибка восстановления cookies: ${error.message}`);
    }
  }

  /**
   * Сохранить текущие cookies в сессию
   * Cookies содержат сессионный ID от сервера, который нужен для последующих запросов
   * Session ID может меняться при каждом запросе, поэтому важно обновлять cookies регулярно
   */
  async saveCookies(): Promise<void> {
    try {
      const cookies = await this.httpService.getCookiesAsArray();
      
      // Логируем только при изменении количества cookies или при первом сохранении
      const previousCookiesCount = this.currentSession?.cookies?.length || 0;
      const hasChanged = cookies.length !== previousCookiesCount;
      
      if (hasChanged || !this.currentSession) {
        this.logger.debug(`Обновление cookies в сессии: ${cookies.length} (было: ${previousCookiesCount})`);
      }
      
      // Логируем важные cookies (например, сессионный ID) только при изменении
      const sessionCookies = cookies.filter(c => 
        c.toLowerCase().includes('session') || 
        c.toLowerCase().includes('sid') ||
        c.toLowerCase().includes('jsessionid')
      );
      if (sessionCookies.length > 0 && hasChanged) {
        this.logger.debug(`Обновлены сессионные cookies: ${sessionCookies.length}`);
      }
      
      if (this.currentSession) {
        this.currentSession.cookies = cookies;
        await this.saveSession({ cookies });
        // Обновляем глобальное состояние
        globalSessionState.cookies = cookies;
      } else {
        // Если сессии еще нет, создаем новую
        await this.saveSession({
          cookies,
          isAuthenticated: false,
        });
        // Обновляем глобальное состояние
        globalSessionState.cookies = cookies;
        globalSessionState.isAuthenticated = false;
      }
    } catch (error) {
      this.logger.error(`Ошибка сохранения cookies: ${error.message}`);
    }
  }

  /**
   * Обновить токен сессии
   */
  async updateToken(token: string | null): Promise<void> {
    if (this.currentSession) {
      this.currentSession.token = token;
      // Обновляем кэш сразу
      if (this.sessionCache) {
        this.sessionCache.token = token;
      }
      await this.saveSession({ token });
    }
  }

  /**
   * Обновить статус авторизации
   */
  async updateAuthStatus(isAuthenticated: boolean): Promise<void> {
    this.logger.log(`Обновление статуса авторизации: isAuthenticated=${isAuthenticated}`);
    if (this.currentSession) {
      this.currentSession.isAuthenticated = isAuthenticated;
      // Обновляем кэш сразу
      if (this.sessionCache) {
        this.sessionCache.isAuthenticated = isAuthenticated;
      }
      await this.saveSession({ isAuthenticated });
      this.logger.log(`Статус авторизации обновлен и сохранен: isAuthenticated=${isAuthenticated}`);
    } else {
      // Если сессии нет, создаем новую
      await this.saveSession({ isAuthenticated });
      this.logger.log(`Создана новая сессия со статусом: isAuthenticated=${isAuthenticated}`);
    }
  }
}

