import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as https from 'https';
import { CookieJar } from 'tough-cookie';
import FormData from 'form-data';

@Injectable()
export class HttpService {
  private readonly logger = new Logger(HttpService.name);
  private readonly client: AxiosInstance;
  private readonly cookieJar: CookieJar;
  private onCookiesUpdatedCallback: (() => Promise<void>) | null = null;
  private onReauthRequiredCallback: (() => Promise<boolean>) | null = null;

  constructor(private configService: ConfigService) {
    this.cookieJar = new CookieJar();

    const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
    // Преобразуем timeout в число (может быть строкой из .env)
    const timeoutConfig = this.configService.get<string | number>('HTTP_TIMEOUT', 30000);
    const timeout = typeof timeoutConfig === 'string' ? parseInt(timeoutConfig, 10) : timeoutConfig;
    const userAgent = this.configService.get<string>(
      'USER_AGENT',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    );
    
    // Определяем версию Chrome из User-Agent для sec-ch-ua заголовков
    const chromeVersionMatch = userAgent.match(/Chrome\/(\d+)/);
    const chromeVersion = chromeVersionMatch ? chromeVersionMatch[1] : '140';

    // Оптимизированный HTTPS Agent с connection pooling
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false, // Для тестирования, в продакшене лучше true
      keepAlive: true, // Переиспользование соединений
      keepAliveMsecs: 1000, // Проверка соединений каждую секунду
      maxSockets: 50, // Максимум одновременных соединений
      maxFreeSockets: 10, // Максимум свободных соединений в пуле
      // timeout не используется в https.Agent, он используется в axios
    });

    this.client = axios.create({
      baseURL,
      timeout,
      withCredentials: true,
      httpsAgent,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Sec-GPC': '1',
        'sec-ch-ua': `"Chromium";v="${chromeVersion}", "Not=A?Brand";v="24", "Brave";v="${chromeVersion}"`,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'Cache-Control': 'max-age=0',
        'DNT': '1',
      },
    });

    this.setupCookieInterceptors();
    this.setupInterceptors();
    this.setupReauthInterceptor();
  }

  private setupCookieInterceptors(): void {
    // Request interceptor - добавляем cookies в заголовки
    this.client.interceptors.request.use(async (config) => {
      const url = config.url?.startsWith('http')
        ? config.url
        : `${config.baseURL}${config.url}`;
      const cookies = await this.cookieJar.getCookies(url);

      if (cookies.length > 0) {
        const cookieString = cookies.map((cookie) => cookie.toString()).join('; ');
        config.headers.Cookie = cookieString;
        this.logger.debug(`Отправка запроса с ${cookies.length} cookies на ${url}`);
      } else {
        this.logger.debug(`Отправка запроса без cookies на ${url}`);
      }

      return config;
    });

    // Response interceptor - сохраняем cookies из ответа
    this.client.interceptors.response.use(async (response) => {
      const setCookieHeaders = response.headers['set-cookie'];
      const url = response.config.url?.startsWith('http')
        ? response.config.url
        : `${response.config.baseURL}${response.config.url}`;
      
      if (setCookieHeaders && setCookieHeaders.length > 0) {
        this.logger.debug(`Получено ${setCookieHeaders.length} cookies в ответе от ${url}`);
        for (const cookieHeader of setCookieHeaders) {
          await this.cookieJar.setCookie(cookieHeader, url);
        }
      }
      
      // ВСЕГДА обновляем cookies в сессии после каждого ответа (даже если set-cookie нет)
      // Это нужно, так как cookies могут быть уже в cookieJar и нужно их синхронизировать
      if (this.onCookiesUpdatedCallback) {
        try {
          await this.onCookiesUpdatedCallback();
          this.logger.debug('Cookies обновлены в сессии через callback');
        } catch (error) {
          this.logger.warn(`Ошибка обновления cookies в сессии: ${(error as Error).message}`);
        }
      }

      return response;
    });
  }

  private setupInterceptors(): void {
    const retryAttempts = this.configService.get<number>('RETRY_ATTEMPTS', 3);
    const retryDelay = this.configService.get<number>('RETRY_DELAY', 1000);

    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        this.logger.log(`${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        this.logger.error(`Request error: ${error.message}`);
        return Promise.reject(error);
      },
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        this.logger.log(`${response.status} ${response.config.url}`);
        return response;
      },
      async (error) => {
        if (error.response) {
          this.logger.error(`${error.response.status} ${error.config?.url}`);
        } else {
          this.logger.error(`Network error: ${error.message}`);
        }

        // Retry logic
        const config = error.config as (AxiosRequestConfig & { retry?: number }) | undefined;
        if (!config) {
          return Promise.reject(error);
        }

        // Инициализируем retry если его нет
        if (config.retry === undefined) {
          config.retry = 0;
        }

        if (config.retry < retryAttempts) {
          config.retry += 1;
          const delay = retryDelay * config.retry;
          this.logger.log(
            `Retrying request (${config.retry}/${retryAttempts}) after ${delay}ms`,
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
          return this.client(config);
        }

        return Promise.reject(error);
      },
    );
  }

  async get(url: string, config: AxiosRequestConfig = {}) {
    return this.client.get(url, {
      ...config,
      maxRedirects: config.maxRedirects ?? 5,
    });
  }

  async post(url: string, data: any = {}, config: AxiosRequestConfig = {}) {
    return this.client.post(url, data, {
      ...config,
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
    });
  }

  async postFormData(url: string, formData: Record<string, any>, config: AxiosRequestConfig = {}) {
    const form = new FormData();
    for (const [key, value] of Object.entries(formData)) {
      form.append(key, value);
    }

    return this.client.post(url, form, {
      ...config,
      headers: {
        ...form.getHeaders(),
        ...config.headers,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
  }

  async postForm(url: string, data: any = {}, config: AxiosRequestConfig = {}) {
    // Преобразуем объект в URL-encoded строку
    const formData = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        value.forEach(v => formData.append(key, String(v)));
      } else {
        formData.append(key, String(value));
      }
    }
    
    return this.client.post(url, formData.toString(), {
      ...config,
      maxRedirects: config.maxRedirects ?? 5,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...config.headers,
      },
    });
  }

  getCookies(): CookieJar {
    return this.cookieJar;
  }

  async setCookie(name: string, value: string, domain: string): Promise<void> {
    const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
    const cookie = `${name}=${value}; Domain=${domain}; Path=/`;
    await this.cookieJar.setCookie(cookie, baseURL);
  }

  async clearCookies(): Promise<void> {
    await this.cookieJar.removeAllCookies();
  }

  /**
   * Получить все cookies в виде массива строк
   */
  async getCookiesAsArray(): Promise<string[]> {
    try {
      const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
      const cookies = await this.cookieJar.getCookies(baseURL);
      return cookies.map((cookie) => cookie.toString());
    } catch (error) {
      this.logger.error(`Ошибка получения cookies: ${error.message}`);
      return [];
    }
  }

  /**
   * Восстановить cookies из массива строк
   */
  async restoreCookies(cookieStrings: string[]): Promise<void> {
    try {
      const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
      for (const cookieString of cookieStrings) {
        await this.cookieJar.setCookie(cookieString, baseURL);
      }
      this.logger.log(`Восстановлено ${cookieStrings.length} cookies`);
    } catch (error) {
      this.logger.error(`Ошибка восстановления cookies: ${error.message}`);
    }
  }

  /**
   * Установить callback для автоматического сохранения cookies в сессии
   * Вызывается после каждого ответа, который содержит set-cookie заголовки
   */
  setOnCookiesUpdatedCallback(callback: () => Promise<void>): void {
    this.onCookiesUpdatedCallback = callback;
    this.logger.log('Callback для обновления cookies в сессии установлен');
  }

  /**
   * Установить callback для автоматической переавторизации
   * Вызывается при обнаружении текста "авторизуйтесь заново" в HTML ответе
   */
  setOnReauthRequiredCallback(callback: () => Promise<boolean>): void {
    this.onReauthRequiredCallback = callback;
    this.logger.log('Callback для переавторизации установлен');
  }

  /**
   * Интерцептор для проверки HTML ответов на необходимость переавторизации
   * Проверяет наличие текста "авторизуйтесь заново" и похожих фраз
   */
  private setupReauthInterceptor(): void {
    this.client.interceptors.response.use(
      async (response) => {
        // Проверяем только HTML ответы
        const contentType = response.headers['content-type'] || '';
        const isHtml = contentType.includes('text/html') || 
                      typeof response.data === 'string' && 
                      (response.data.includes('<!DOCTYPE') || 
                       response.data.includes('<html') ||
                       response.data.includes('<title>'));

        if (isHtml && typeof response.data === 'string') {
          const url = response.config.url || '';
          
          // Исключаем эндпоинты авторизации из проверки
          const excludedUrls = [
            '/ru/user/sendkey/kz',
            '/user/sendkey/kz',
            'sendkey/kz',
            '/ru/user/auth_confirm',
            '/user/auth_confirm',
            'auth_confirm',
            '/ru/myapp/actionShowApp',
          ];
          
          const isExcluded = excludedUrls.some(excludedUrl => url.includes(excludedUrl));
          if (isExcluded) {
            return response; // Пропускаем проверку для эндпоинтов авторизации
          }
          
          // Более надежная проверка необходимости переавторизации
          let needsReauth = false;
          
          // Исключаем страницы ошибок (404, 500 и т.д.) если это не реальная страница авторизации
          const isErrorPage = url.includes('error_report') || 
                             url.includes('not_found') || 
                             (typeof response.data === 'string' && response.data.includes('Страница не найдена'));
          
          // 1. Проверка редиректа на страницу авторизации (самый надежный способ)
          if (response.status === 302 || response.status === 301) {
            const location = response.headers.location || '';
            if (location.includes('/user/auth') || location.includes('/user/login') || location.includes('/login')) {
              needsReauth = true;
              this.logger.debug(`Обнаружен редирект на страницу авторизации: ${location}`);
            }
          }
          
          // 2. Проверка статус кода 401/403 (но не 404, если это страница ошибки)
          if ((response.status === 401 || response.status === 403) && !isErrorPage) {
            needsReauth = true;
            this.logger.debug(`Обнаружен статус код ${response.status} - требуется авторизация`);
          }
          
          // 3. Проверка HTML содержимого на признаки страницы авторизации (только если не страница ошибки)
          if (!needsReauth && !isErrorPage && typeof response.data === 'string') {
            const html = response.data.toLowerCase();
            
            // Строгие индикаторы страницы авторизации (форма с полями логина/пароля)
            const strictAuthIndicators = [
              'type="password"', // Поле пароля - обязательный признак формы авторизации
              'name="password"',
              'id="password"',
              'name="login"',
              'id="login"',
            ];
            
            // Дополнительные индикаторы (должны быть вместе со строгими)
            const additionalIndicators = [
              '<form',
              'type="submit"',
              'войти в систему',
              'вход в систему',
            ];
            
            // Проверяем наличие строгих индикаторов (обязательно)
            const hasStrictAuth = strictAuthIndicators.some(indicator => html.includes(indicator));
            
            // Проверяем дополнительные индикаторы
            const hasAdditional = additionalIndicators.some(indicator => html.includes(indicator));
            
            // Дополнительная проверка: наличие редиректа в HTML (meta refresh, window.location)
            const hasAuthRedirect = html.includes('window.location') && 
                                   (html.includes('/user/auth') || html.includes('/user/login') || html.includes('/login'));
            
            // Проверяем title страницы
            const hasAuthTitle = html.includes('<title>') && 
                                (html.includes('авторизация') || html.includes('вход') || html.includes('login'));
            
            // Требуем наличие строгих индикаторов И (дополнительных ИЛИ title ИЛИ редирект)
            // Это гарантирует, что это действительно страница авторизации, а не просто упоминание
            if (hasStrictAuth && (hasAdditional || hasAuthTitle || hasAuthRedirect)) {
              needsReauth = true;
              this.logger.debug('Обнаружены строгие признаки страницы авторизации в HTML');
            }
          }

          if (needsReauth && this.onReauthRequiredCallback) {
            // Проверяем, не выполнялась ли уже переавторизация для этого запроса
            if ((response.config as any)._reauthPerformed) {
              this.logger.warn('⚠️  Переавторизация уже выполнялась для этого запроса, пропускаем');
              return response;
            }

            this.logger.warn(`⚠️  Обнаружена необходимость переавторизации в ответе от ${url} (статус: ${response.status})`);
            this.logger.log('Выполняем переавторизацию...');

            try {
              // Помечаем, что переавторизация выполняется
              (response.config as any)._reauthPerformed = true;
              
              const reauthSuccess = await this.onReauthRequiredCallback();
              
              if (reauthSuccess) {
                this.logger.log('✅ Переавторизация успешна, повторяем запрос...');
                
                // Повторяем исходный запрос с обновленными cookies
                const retryConfig = {
                  ...response.config,
                  _reauthRetry: (response.config as any)._reauthRetry || 0,
                };

                // Защита от бесконечного цикла (максимум 1 повтор)
                if ((retryConfig as any)._reauthRetry >= 1) {
                  this.logger.error('❌ Превышено максимальное количество попыток переавторизации');
                  return response;
                }

                (retryConfig as any)._reauthRetry = ((retryConfig as any)._reauthRetry || 0) + 1;

                // Повторяем запрос
                const retryResponse = await this.client.request(retryConfig);
                
                // Проверяем, не требуется ли еще раз переавторизация
                let stillNeedsReauth = false;
                
                // Проверка редиректа
                if (retryResponse.status === 302 || retryResponse.status === 301) {
                  const location = retryResponse.headers.location || '';
                  if (location.includes('/user/auth') || location.includes('/user/login') || location.includes('/login')) {
                    stillNeedsReauth = true;
                  }
                }
                
                // Проверка статус кода
                if (retryResponse.status === 401 || retryResponse.status === 403) {
                  stillNeedsReauth = true;
                }

                if (stillNeedsReauth) {
                  this.logger.error('❌ После переавторизации все еще требуется авторизация');
                  return response; // Возвращаем исходный ответ
                }

                this.logger.log('✅ Запрос успешно повторен после переавторизации');
                return retryResponse;
              } else {
                this.logger.error('❌ Переавторизация не удалась');
                return response;
              }
            } catch (error) {
              this.logger.error(`❌ Ошибка при переавторизации: ${(error as Error).message}`);
              return response;
            }
          }
        }

        return response;
      },
      async (error) => {
        // Также проверяем ошибки на необходимость переавторизации
        if (error.response) {
          const contentType = error.response.headers['content-type'] || '';
          const isHtml = contentType.includes('text/html') || 
                        typeof error.response.data === 'string' && 
                        (error.response.data.includes('<!DOCTYPE') || 
                         error.response.data.includes('<html'));

          if (isHtml && typeof error.response.data === 'string') {
            const url = error.config?.url || '';
            
            // Исключаем эндпоинты авторизации из проверки
            const excludedUrls = [
              '/ru/user/sendkey/kz',
              '/user/sendkey/kz',
              'sendkey/kz',
              '/ru/user/auth_confirm',
              '/user/auth_confirm',
              'auth_confirm',
            ];
            
            const isExcluded = excludedUrls.some(excludedUrl => url.includes(excludedUrl));
            if (isExcluded) {
              return Promise.reject(error); // Пропускаем проверку для эндпоинтов авторизации
            }
            
            // Более надежная проверка необходимости переавторизации для ошибок
            let needsReauth = false;
            
            const errorUrl = error.config?.url || '';
            const isErrorPage = errorUrl.includes('error_report') || 
                               errorUrl.includes('not_found') || 
                               (typeof error.response.data === 'string' && error.response.data.includes('Страница не найдена'));
            
            // 1. Проверка статус кода 401/403 (но не 404, если это страница ошибки)
            if ((error.response.status === 401 || error.response.status === 403) && !isErrorPage) {
              needsReauth = true;
              this.logger.debug(`Обнаружен статус код ${error.response.status} - требуется авторизация`);
            }
            
            // 2. Проверка редиректа на страницу авторизации
            if (error.response.status === 302 || error.response.status === 301) {
              const location = error.response.headers.location || '';
              if (location.includes('/user/auth') || location.includes('/user/login') || location.includes('/login')) {
                needsReauth = true;
                this.logger.debug(`Обнаружен редирект на страницу авторизации: ${location}`);
              }
            }
            
            // 3. Проверка HTML содержимого на признаки страницы авторизации (только если не страница ошибки)
            if (!needsReauth && !isErrorPage && typeof error.response.data === 'string') {
              const html = error.response.data.toLowerCase();
              
              // Строгие индикаторы страницы авторизации
              const strictAuthIndicators = [
                'type="password"',
                'name="password"',
                'id="password"',
                'name="login"',
                'id="login"',
              ];
              
              const additionalIndicators = [
                '<form',
                'type="submit"',
                'войти в систему',
                'вход в систему',
              ];
              
              const hasStrictAuth = strictAuthIndicators.some(indicator => html.includes(indicator));
              const hasAdditional = additionalIndicators.some(indicator => html.includes(indicator));
              const hasAuthRedirect = html.includes('window.location') && 
                                     (html.includes('/user/auth') || html.includes('/user/login') || html.includes('/login'));
              const hasAuthTitle = html.includes('<title>') && 
                                  (html.includes('авторизация') || html.includes('вход') || html.includes('login'));
              
              // Требуем наличие строгих индикаторов
              if (hasStrictAuth && (hasAdditional || hasAuthTitle || hasAuthRedirect)) {
                needsReauth = true;
                this.logger.debug('Обнаружены строгие признаки страницы авторизации в HTML ответе с ошибкой');
              }
            }

            if (needsReauth && this.onReauthRequiredCallback) {
              // Проверяем, не выполнялась ли уже переавторизация для этого запроса
              if (error.config && (error.config as any)._reauthPerformed) {
                this.logger.warn('⚠️  Переавторизация уже выполнялась для этого запроса, пропускаем');
                return Promise.reject(error);
              }

              this.logger.warn(`⚠️  Обнаружен индикатор переавторизации в ответе с ошибкой от ${url}`);
              this.logger.log('Выполняем переавторизацию...');

              try {
                // Помечаем, что переавторизация выполняется
                if (error.config) {
                  (error.config as any)._reauthPerformed = true;
                }
                
                const reauthSuccess = await this.onReauthRequiredCallback();
                
                if (reauthSuccess && error.config) {
                  this.logger.log('✅ Переавторизация успешна, повторяем запрос...');
                  
                  const retryConfig = {
                    ...error.config,
                    _reauthRetry: (error.config as any)._reauthRetry || 0,
                  };

                  // Защита от бесконечного цикла
                  if ((retryConfig as any)._reauthRetry >= 1) {
                    this.logger.error('❌ Превышено максимальное количество попыток переавторизации');
                    return Promise.reject(error);
                  }

                  (retryConfig as any)._reauthRetry = ((retryConfig as any)._reauthRetry || 0) + 1;

                  // Повторяем запрос
                  return this.client.request(retryConfig);
                } else {
                  this.logger.error('❌ Переавторизация не удалась');
                  return Promise.reject(error);
                }
              } catch (reauthError) {
                this.logger.error(`❌ Ошибка при переавторизации: ${(reauthError as Error).message}`);
                return Promise.reject(error);
              }
            }
          }
        }

        return Promise.reject(error);
      },
    );
  }
}

