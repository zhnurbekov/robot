import { NestFactory } from '@nestjs/core';
import { HttpLogCronAppModule } from './http-log-cron-app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('HttpLogCronBootstrap');

  const app = await NestFactory.create(HttpLogCronAppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const port = process.env.HTTP_LOG_CRON_PORT || 3007;
  await app.listen(port);

  logger.log(`Крон HTTP-логов запущен, порт: ${port}`);
  logger.log('Данные из Redis (http:requests:log) переносятся в БД каждую минуту');
}

bootstrap();
