import { NestFactory } from '@nestjs/core';
import { FileDownloaderAppModule } from './file-downloader-app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('FileDownloaderBootstrap');

  const app = await NestFactory.create(FileDownloaderAppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const port = process.env.FILE_DOWNLOADER_PORT || 3005;
  await app.listen(port);

  logger.log(`File Downloader запущен, порт: ${port}`);
  logger.log('Скачивание файлов из избранного выполняется каждую минуту');
}

bootstrap();
