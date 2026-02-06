import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '../http/http.module';
import { RedisModule } from '../redis/redis.module';
import { PortalModule } from '../portal/portal.module';
import { NcanodeModule } from '../ncanode/ncanode.module';
import { FileDownloaderService } from './file-downloader.service';

/**
 * Модуль только с FileDownloaderService (без scheduler)
 * Используется в основном приложении для доступа к сервису без запуска cron
 */
@Module({
  imports: [HttpModule, RedisModule, PortalModule, NcanodeModule],
  providers: [FileDownloaderService],
  exports: [FileDownloaderService],
})
export class FileDownloaderCoreModule {}
