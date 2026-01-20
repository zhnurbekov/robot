import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from './modules/http/http.module';
import { PortalModule } from './modules/portal/portal.module';
import { SessionModule } from './modules/session/session.module';
import { AuthModule } from './modules/auth/auth.module';
import { NcanodeModule } from './modules/ncanode/ncanode.module';
import { ApplicationModule } from './modules/application/application.module';
import { FileProcessorModule } from './modules/file-processor/file-processor.module';
import { RedisModule } from './modules/redis/redis.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SessionService } from './modules/session/session.service';

@Module({
  imports: [
    // Конфигурация
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // Планировщик задач
    ScheduleModule.forRoot(),
    // Redis для кэширования
    RedisModule,
    // Модули приложения
    HttpModule,
    SessionModule,
    PortalModule,
    NcanodeModule,
    AuthModule,
    ApplicationModule,
    FileProcessorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements OnModuleInit {
  constructor(private sessionService: SessionService) {}

  async onModuleInit() {
    // Инициализируем сессию при старте приложения
    await this.sessionService.initialize();
  }
}


