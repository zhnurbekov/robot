import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from './modules/http/http.module';
import { SessionModule } from './modules/session/session.module';
import { AuthModule } from './modules/auth/auth.module';
import { RedisModule } from './modules/redis/redis.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { AnnounceMonitorModule } from './modules/announce-monitor/announce-monitor.module';
import { SessionService } from './modules/session/session.service';
import { AuthService } from './modules/auth/auth.service';
import { Logger } from '@nestjs/common';

@Module({
  imports: [
    // Конфигурация
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // Планировщик задач
    ScheduleModule.forRoot(),
    // Redis для кэширования сессий
    RedisModule,
    // Модули для мониторинга
    HttpModule,
    SessionModule,
    AuthModule,
    TelegramModule,
    AnnounceMonitorModule,
  ],
  providers: [],
})
export class MonitorAppModule implements OnModuleInit {
  private readonly logger = new Logger(MonitorAppModule.name);

  constructor(
    private sessionService: SessionService,
    private authService: AuthService,
    private configService: ConfigService,
  ) {}

  async onModuleInit() {
    this.logger.log('Инициализация сервиса мониторинга...');
    
    // Инициализируем сессию при старте приложения
    await this.sessionService.initialize();
    this.logger.log('Сессия инициализирована');

    // Выполняем авторизацию
    try {
      this.logger.log('Выполнение авторизации...');
      const authResult = await this.authService.login(false);
      
      if (authResult) {
        this.logger.log('✅ Авторизация успешна');
        console.log('[MonitorApp] ✅ Авторизация выполнена успешно');
      } else {
        this.logger.error('❌ Авторизация не удалась');
        console.log('[MonitorApp] ❌ Ошибка авторизации');
      }
    } catch (error) {
      this.logger.error(`Ошибка при авторизации: ${error.message}`);
      console.error('[MonitorApp] Ошибка авторизации:', error.message);
      if (error.stack) {
        this.logger.debug(error.stack);
      }
    }

    this.logger.log('Сервис мониторинга готов к работе');
  }
}

