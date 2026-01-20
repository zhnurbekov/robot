import { NestFactory } from '@nestjs/core';
import { MonitorAppModule } from './monitor-app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('MonitorBootstrap');
  
  // Создаем приложение с включенным логированием
  const app = await NestFactory.create(MonitorAppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });
  
  // Глобальный префикс для API (если нужен)
  app.setGlobalPrefix('api');
  
  // Включение CORS если нужно
  app.enableCors();
  
  // Порт для сервиса мониторинга (по умолчанию 3001)
  const port = process.env.MONITOR_PORT || 3003;
  await app.listen(port);
  
  logger.log(`🔍 Monitor Service is running on: http://localhost:${port}/api`);
  logger.log(`📊 Announcement monitoring started`);
  console.log('=== Сервис мониторинга объявлений запущен ===');
  console.log(`Порт: ${port}`);
}

bootstrap();

