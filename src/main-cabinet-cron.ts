import { NestFactory } from '@nestjs/core';
import { CabinetCronAppModule } from './cabinet-cron-app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('CabinetCronBootstrap');

  const app = await NestFactory.create(CabinetCronAppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const port = process.env.CABINET_CRON_PORT || 3004;
  await app.listen(port);

  logger.log(`Крон кабинета запущен, порт: ${port}`);
  logger.log('Запросы tax_debts и permits выполняются каждый час в :00');
}

bootstrap();
