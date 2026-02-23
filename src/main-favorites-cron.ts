import { NestFactory } from '@nestjs/core';
import { FavoritesCronAppModule } from './favorites-cron-app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('FavoritesCronBootstrap');

  const app = await NestFactory.create(FavoritesCronAppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const port = process.env.FAVORITES_CRON_PORT || 3008;
  await app.listen(port);

  logger.log(`Крон избранного запущен, порт: ${port}`);
  logger.log('Запрос /ru/favorites по расписанию, при смене статуса — запись в БД');
}

bootstrap();
