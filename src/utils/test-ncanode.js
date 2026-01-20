import config from '../config/config.js';
import NcanodeService from '../services/ncanode-service.js';

/**
 * Тестовый скрипт для проверки подключения к ncanode
 */
async function testNcanode() {
  console.log('=== Тест подключения к ncanode ===\n');

  const ncanodeService = new NcanodeService(config);

  try {
    // Проверка доступности
    console.log('1. Проверка доступности ncanode...');
    const isAvailable = await ncanodeService.healthCheck();
    
    if (!isAvailable) {
      console.error('✗ ncanode недоступен');
      console.log(`\nУбедитесь, что ncanode запущен на ${config.ncanode.url}`);
      console.log('Запустите: java -jar ncanode.jar --port 14579');
      process.exit(1);
    }
    
    console.log('✓ ncanode доступен\n');

    // Проверка информации о сертификате
    if (config.auth.certPath) {
      console.log('2. Проверка сертификата...');
      try {
        const certInfo = await ncanodeService.getCertInfo(
          config.auth.certPath,
          config.auth.certPassword
        );
        console.log('✓ Сертификат валиден');
        console.log('Информация о сертификате:', JSON.stringify(certInfo, null, 2));
      } catch (error) {
        console.error('✗ Ошибка при проверке сертификата:', error.message);
        console.log('\nПроверьте:');
        console.log('- Путь к сертификату (CERT_PATH)');
        console.log('- Пароль от сертификата (CERT_PASSWORD)');
        console.log('- Сертификат не истек');
      }
    } else {
      console.log('2. Сертификат не указан в конфигурации (CERT_PATH)');
    }

    console.log('\n=== Тест завершен ===');
  } catch (error) {
    console.error('Ошибка:', error.message);
    process.exit(1);
  }
}

// Запуск если файл выполняется напрямую
if (import.meta.url === `file://${process.argv[1]}`) {
  testNcanode();
}

export { testNcanode };



















