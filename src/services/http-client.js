import axios from 'axios';
import https from 'https';
import { CookieJar } from 'tough-cookie';

/**
 * HTTP клиент с имитацией браузера
 * Поддерживает cookies, user-agent, и другие заголовки браузера
 */
class HttpClient {
  constructor(config) {
    this.config = config;
    this.cookieJar = new CookieJar();
    
    // Создаем axios instance
    this.client = axios.create({
      baseURL: config.portal.baseUrl,
      timeout: config.http.timeout,
      withCredentials: true,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false, // Для тестирования, в продакшене лучше true
      }),
      headers: {
        'User-Agent': config.http.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0',
      },
    });

    // Добавляем поддержку cookies через interceptors
    this.setupCookieInterceptors();

    // Добавляем interceptors для логирования
    this.setupInterceptors();
  }

  /**
   * Настройка interceptors для работы с cookies
   */
  setupCookieInterceptors() {
    // Request interceptor - добавляем cookies в заголовки
    this.client.interceptors.request.use(async (config) => {
      const url = config.url.startsWith('http') ? config.url : `${config.baseURL}${config.url}`;
      const cookies = await this.cookieJar.getCookies(url);
      
      if (cookies.length > 0) {
        const cookieString = cookies.map(cookie => cookie.toString()).join('; ');
        config.headers.Cookie = cookieString;
      }
      
      return config;
    });

    // Response interceptor - сохраняем cookies из ответа
    this.client.interceptors.response.use(async (response) => {
      const setCookieHeaders = response.headers['set-cookie'];
      if (setCookieHeaders) {
        const url = response.config.url.startsWith('http') 
          ? response.config.url 
          : `${response.config.baseURL}${response.config.url}`;
        
        for (const cookieHeader of setCookieHeaders) {
          await this.cookieJar.setCookie(cookieHeader, url);
        }
      }
      
      return response;
    });
  }

  setupInterceptors() {
    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        console.log(`[HTTP] ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        console.error('[HTTP] Request error:', error.message);
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        console.log(`[HTTP] ${response.status} ${response.config.url}`);
        return response;
      },
      async (error) => {
        if (error.response) {
          console.error(`[HTTP] ${error.response.status} ${error.config?.url}`);
        } else {
          console.error('[HTTP] Network error:', error.message);
        }

        // Retry logic
        const config = error.config;
        if (!config || !config.retry) {
          config.retry = 0;
        }

        if (config.retry < this.config.http.retryAttempts) {
          config.retry += 1;
          const delay = this.config.http.retryDelay * config.retry;
          console.log(`[HTTP] Retrying request (${config.retry}/${this.config.http.retryAttempts}) after ${delay}ms`);
          
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.client(config);
        }

        return Promise.reject(error);
      }
    );
  }

  /**
   * GET запрос
   */
  async get(url, config = {}) {
    return this.client.get(url, config);
  }

  /**
   * POST запрос
   */
  async post(url, data = {}, config = {}) {
    return this.client.post(url, data, {
      ...config,
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
    });
  }

  /**
   * POST запрос с form-data (multipart/form-data)
   * @param {string} url - URL для запроса
   * @param {Object|FormData} formData - Данные для отправки (объект или FormData)
   * @param {Object} config - Дополнительная конфигурация
   */
  async postFormData(url, formData, config = {}) {
    const FormDataModule = (await import('form-data')).default;
    
    // Если передан объект FormData, используем его напрямую
    // Иначе создаем FormData из объекта
    let form;
    if (formData instanceof FormDataModule) {
      form = formData;
    } else {
      form = new FormDataModule();
      for (const [key, value] of Object.entries(formData)) {
        // Если значение - строка, добавляем как есть
        // Если значение - Buffer или Stream, тоже поддерживается
        form.append(key, value);
      }
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

  /**
   * POST запрос с form-urlencoded
   */
  async postForm(url, data = {}, config = {}) {
    return this.client.post(url, data, {
      ...config,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...config.headers,
      },
    });
  }

  /**
   * Получить cookies
   */
  getCookies() {
    return this.cookieJar;
  }

  /**
   * Установить cookie
   */
  async setCookie(name, value, domain) {
    const cookie = `${name}=${value}; Domain=${domain}; Path=/`;
    await this.cookieJar.setCookie(cookie, this.config.portal.baseUrl);
  }

  /**
   * Очистить cookies
   */
  async clearCookies() {
    await this.cookieJar.removeAllCookies();
  }
}

export default HttpClient;

