import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from './modules/redis/redis.module';
import { ErrorLogModule } from './modules/error-log/error-log.module';
import { HttpModule } from './modules/http/http.module';
import { SessionModule } from './modules/session/session.module';
import { AuthModule } from './modules/auth/auth.module';
import { PortalModule } from './modules/portal/portal.module';
import { NcanodeModule } from './modules/ncanode/ncanode.module';
import { FavoritesCronModule } from './modules/favorites-cron/favorites-cron.module';
import { SessionService } from './modules/session/session.service';
import { Logger } from '@nestjs/common';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
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
    ScheduleModule.forRoot(),
    RedisModule,
    ErrorLogModule,
    HttpModule,
    SessionModule,
    NcanodeModule,
    AuthModule,
    PortalModule,
    FavoritesCronModule,
  ],
})
export class FavoritesCronAppModule implements OnModuleInit {
  private readonly logger = new Logger(FavoritesCronAppModule.name);

  constructor(private sessionService: SessionService) {}

  async onModuleInit() {
    this.logger.log('Инициализация крона избранного...');
    await this.sessionService.initialize();
    this.logger.log('Крон избранного готов: запрос /ru/favorites по расписанию, при смене статуса — запись в БД');
  }
}
