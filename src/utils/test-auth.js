import config from '../config/config.js';
import HttpClient from '../services/http-client.js';
import AuthService from '../services/auth-service.js';
import NcanodeService from '../services/ncanode-service.js';

/**
 * Тестовый скрипт для проверки авторизации
 */
async function testAuth() {
  console.log('=== Тест авторизации ===\n');

  try {
    // Инициализация сервисов
    const httpClient = new HttpClient(config);
    const ncanodeService = new NcanodeService(config);
    const authService = new AuthService(config, httpClient, ncanodeService);

    // Проверка доступности ncanode
    console.log('1. Проверка доступности ncanode...');
    const isAvailable = await ncanodeService.healthCheck();
    
    if (!isAvailable) {
      console.error('✗ ncanode недоступен');
      console.log(`\nУбедитесь, что ncanode запущен на ${config.ncanode.url}`);
      process.exit(1);
    }
    console.log('✓ ncanode доступен\n');

    // Проверка сертификата
    if (!config.auth.certPath) {
      console.error('✗ Путь к сертификату не указан (CERT_PATH в .env)');
      process.exit(1);
    }

    console.log('2. Проверка сертификата...');
    try {
      const certInfo = await ncanodeService.getCertInfo(
        config.auth.certPath,
        config.auth.certPassword
      );
      console.log('✓ Сертификат валиден\n');
    } catch (error) {
      console.error('✗ Ошибка при проверке сертификата:', error.message);
      process.exit(1);
    }

    // Тест получения ключа
    console.log('3. Тест получения ключа от портала...');
    try {
      const keyResponse = await httpClient.post('/ru/user/sendkey/kz', {}, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      
      const key = authService.extractKeyFromResponse(keyResponse);
      if (key) {
        console.log('✓ Ключ получен:', key);
        console.log('  Длина ключа:', key.length);
      } else {
        console.log('⚠ Ключ не найден в ответе');
        console.log('  Ответ сервера:', keyResponse.data);
      }
    } catch (error) {
      console.error('✗ Ошибка получения ключа:', error.message);
      if (error.response) {
        console.error('  Статус:', error.response.status);
        console.error('  Данные:', error.response.data);
      }
    }

    console.log('\n4. Попытка авторизации...');
    try {
      const result = await authService.login();
      if (result) {
        console.log('✓ Авторизация успешна!');
        console.log('  Токен сессии:', authService.getSessionToken() || 'не получен');
      } else {
        console.log('✗ Авторизация не удалась');
      }
    } catch (error) {
      console.error('✗ Ошибка авторизации:', error.message);
    }

    console.log('\n=== Тест завершен ===');
  } catch (error) {
    console.error('Критическая ошибка:', error.message);
    process.exit(1);
  }
}

// Запуск если файл выполняется напрямую
if (import.meta.url === `file://${process.argv[1]}`) {
  testAuth();
}

export { testAuth };



















