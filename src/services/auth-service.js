import HttpClient from './http-client.js';

/**
 * Сервис авторизации через SSO с ЭЦП
 */
class AuthService {
  constructor(config, httpClient, ncanodeService) {
    this.config = config;
    this.httpClient = httpClient;
    this.ncanodeService = ncanodeService;
    this.sessionToken = null;
    this.isAuthenticated = false;
  }

  /**
   * Авторизация через SSO с ЭЦП
   * Процесс:
   * 1. POST запрос на /ru/user/sendkey/kz для получения ключа
   * 2. Подпись XML с ключом через ncanode (nclayer формат)
   * 3. Отправка подписанного XML для завершения авторизации
   */
  async login() {
    try {
      console.log('[AUTH] Начало авторизации...');

      // Шаг 1: Получаем ключ для подписи
      console.log('[AUTH] Получение ключа для подписи...');
      const keyResponse = await this.httpClient.post('/ru/user/sendkey/kz', {}, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      // Извлекаем ключ из ответа
      const key = this.extractKeyFromResponse(keyResponse);
      if (!key) {
        throw new Error('Не удалось получить ключ для подписи');
      }
      console.log('[AUTH] Ключ получен:', key);

      // Шаг 2: Подписываем XML с ключом через ncanode (nclayer формат)
      console.log('[AUTH] Подпись XML через ncanode...');
      const signedXmlResult = await this.ncanodeService.signWithNclayer(
        key,
        this.config.auth.certPath,
        this.config.auth.certPassword
      );
      console.log('[AUTH] XML подписан');
      console.log(signedXmlResult,'signedXmlResult');

      
      // const authResponse = await this.httpClient.postFormData('/user/sendsign/kz', {
      //   sign: signedXml,
      // });


    } catch (error) {
      console.error('[AUTH] Ошибка авторизации:', error.message);
      if (error.response) {
        console.error('[AUTH] Ответ сервера:', error.response.status, error.response.data);
      }
      this.isAuthenticated = false;
      throw error;
    }
  }

  /**
   * Извлечь ключ из ответа
   * Ключ может быть в разных форматах:
   * - Просто строка в теле ответа
   * - В JSON объекте
   * - В HTML странице
   */
  extractKeyFromResponse(response) {
    try {
      // Если ответ - строка (текст)
      if (typeof response.data === 'string') {
        // Пытаемся найти ключ в тексте (32 символа hex)
        const keyMatch = response.data.match(/[a-f0-9]{32}/i);
        if (keyMatch) {
          return keyMatch[0];
        }
        // Или просто возвращаем весь текст, если он короткий (вероятно это ключ)
        if (response.data.length <= 64 && /^[a-f0-9]+$/i.test(response.data.trim())) {
          return response.data.trim();
        }
      }

      // Если ответ - JSON
      if (typeof response.data === 'object') {
        return response.data.key || response.data.data || response.data.token;
      }

      return null;
    } catch (error) {
      console.error('[AUTH] Ошибка извлечения ключа:', error.message);
      return null;
    }
  }


  /**
   * Выход
   */
  async logout() {
    try {
      await this.httpClient.post('/logout');
      this.isAuthenticated = false;
      this.sessionToken = null;
      await this.httpClient.clearCookies();
      console.log('[AUTH] Выход выполнен');
    } catch (error) {
      console.error('[AUTH] Ошибка выхода:', error.message);
    }
  }

}

export default AuthService;

