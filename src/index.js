import config from './config/config.js';
import HttpClient from './services/http-client.js';
import AuthService from './services/auth-service.js';
import NcanodeService from './services/ncanode-service.js';
import ApplicationService from './services/application-service.js';

/**
 * Главный файл приложения
 * Можно использовать для ручного запуска или тестирования
 */
async function main() {
  try {
    console.log('=== Сервис автоматизации подачи заявок ===\n');

    // Инициализация сервисов
    const httpClient = new HttpClient(config);
    const ncanodeService = new NcanodeService(config);
    const authService = new AuthService(config, httpClient, ncanodeService);
    const applicationService = new ApplicationService(
      config,
      httpClient,
      authService,
      ncanodeService
    );

    // Проверка доступности ncanode
    console.log('Проверка доступности ncanode...');
    const ncanodeAvailable = await ncanodeService.healthCheck();
    if (!ncanodeAvailable) {
      throw new Error('ncanode недоступен. Убедитесь, что сервис запущен на порту ' + config.ncanode.port);
    }
    console.log('✓ ncanode доступен\n');

    // Авторизация
    console.log('Авторизация...');
    await authService.login();
    console.log('✓ Авторизация успешна\n');

    // Пример подачи заявки
    // Раскомментируйте и настройте под ваши нужды:
    /*
    const applicationData = {
      lotId: '12345',
      // Другие данные заявки
    };

    const result = await applicationService.submitApplication(applicationData);
    console.log('Результат подачи заявки:', result);
    */

    console.log('Готово!');
  } catch (error) {
    console.error('Ошибка:', error.message);
    process.exit(1);
  }
}

// Запуск если файл выполняется напрямую
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main };

