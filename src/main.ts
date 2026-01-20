import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  
  // Создаем приложение с включенным логированием
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'], // Включаем все уровни логирования
  });
  
  // Глобальный префикс для API
  app.setGlobalPrefix('api');
  
  // Включение CORS если нужно
  app.enableCors();
  
  const port = process.env.PORT || 3000;
  await app.listen(port);
  
  logger.log(`🚀 Application is running on: http://localhost:${port}/api`);
  logger.log(`📚 API Documentation: http://localhost:${port}/api`);
  console.log('=== Приложение запущено ===');
}

bootstrap();
