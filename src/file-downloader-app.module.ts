import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from './modules/http/http.module';
import { SessionModule } from './modules/session/session.module';
import { AuthModule } from './modules/auth/auth.module';
import { RedisModule } from './modules/redis/redis.module';
import { PortalModule } from './modules/portal/portal.module';
import { FileDownloaderModule } from './modules/file-downloader/file-downloader.module';
import { SessionService } from './modules/session/session.service';
import { AuthService } from './modules/auth/auth.service';
import { Logger } from '@nestjs/common';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    RedisModule,
    HttpModule,
    SessionModule,
    AuthModule,
    PortalModule,
    FileDownloaderModule,
  ],
  providers: [],
})
export class FileDownloaderAppModule implements OnModuleInit {
  private readonly logger = new Logger(FileDownloaderAppModule.name);

  constructor(
    private sessionService: SessionService,
    private authService: AuthService,
    private configService: ConfigService,
  ) {}

  async onModuleInit() {
    this.logger.log('Инициализация сервиса File Downloader...');

    await this.sessionService.initialize();
    this.logger.log('Сессия инициализирована');

    try {
      this.logger.log('Выполнение авторизации...');
      const authResult = await this.authService.login(false);

      if (authResult) {
        this.logger.log('✅ Авторизация успешна');
      } else {
        this.logger.error('❌ Авторизация не удалась');
      }
    } catch (error) {
      this.logger.error(`Ошибка при авторизации: ${(error as Error).message}`);
      if ((error as Error).stack) {
        this.logger.debug((error as Error).stack);
      }
    }

    this.logger.log('Сервис File Downloader готов (скачивание файлов каждую минуту)');
  }
}
