import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { FileDownloaderService } from './file-downloader.service';

@Injectable()
export class FileDownloaderScheduler implements OnModuleInit {
  private readonly logger = new Logger(FileDownloaderScheduler.name);
  private isEnabled = true;

  constructor(
    private fileDownloaderService: FileDownloaderService,
    private configService: ConfigService,
  ) {}

  onModuleInit() {
    const enabled = this.configService.get<string>('FILE_DOWNLOADER_ENABLED', 'true') === 'true';
    this.isEnabled = enabled;
    if (enabled) {
      this.logger.log('FileDownloaderScheduler инициализирован: задача запускается каждую минуту');
    } else {
      this.logger.log('FileDownloaderScheduler отключен (FILE_DOWNLOADER_ENABLED=false)');
    }
  }

  /**
   * Каждую минуту
   */
  @Cron('* * * * *')
  async handleMinuteCron() {
    if (!this.isEnabled) return;

    try {
      await this.fileDownloaderService.runDownloadTask();
    } catch (error) {
      this.logger.error(`Ошибка в задаче загрузки файлов: ${(error as Error).message}`);
    }
  }
}
