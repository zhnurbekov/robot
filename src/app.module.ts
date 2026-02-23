import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from './modules/http/http.module';
import { PortalModule } from './modules/portal/portal.module';
import { SessionModule } from './modules/session/session.module';
import { AuthModule } from './modules/auth/auth.module';
import { NcanodeModule } from './modules/ncanode/ncanode.module';
import { ApplicationModule } from './modules/application/application.module';
import { FileProcessorModule } from './modules/file-processor/file-processor.module';
import { RedisModule } from './modules/redis/redis.module';
import { ErrorLogModule } from './modules/error-log/error-log.module';
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
    // PostgreSQL
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get<string>('DB_USERNAME', 'postgres'),
        password: configService.get<string>('DB_PASSWORD', 'postgres'),
        database: configService.get<string>('DB_DATABASE', 'goszakup'),
        autoLoadEntities: true,
        synchronize: configService.get<string>('NODE_ENV') !== 'production',
        logging: configService.get<string>('DB_LOGGING') === 'true',
      }),
      inject: [ConfigService],
    }),
    // Планировщик задач
    ScheduleModule.forRoot(),
    RedisModule,
    ErrorLogModule,
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


