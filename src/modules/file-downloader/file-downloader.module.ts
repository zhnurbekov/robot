import { Module } from '@nestjs/common';
import { HttpModule } from '../http/http.module';
import { RedisModule } from '../redis/redis.module';
import { PortalModule } from '../portal/portal.module';
import { FileDownloaderService } from './file-downloader.service';
import { FileDownloaderScheduler } from './file-downloader.scheduler';
import { FileDownloaderCoreModule } from './file-downloader-core.module';

/**
 * Полный модуль с FileDownloaderService и FileDownloaderScheduler
 * Используется только в отдельном сервисе file-downloader-app.module.ts
 */
@Module({
  imports: [FileDownloaderCoreModule],
  providers: [FileDownloaderScheduler],
  exports: [FileDownloaderCoreModule], // Экспортируем весь модуль, чтобы FileDownloaderService был доступен
})
export class FileDownloaderModule {}
