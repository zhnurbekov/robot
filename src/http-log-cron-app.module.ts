import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from './modules/redis/redis.module';
import { HttpLogCronModule } from './modules/http-log-cron/http-log-cron.module';
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
    HttpLogCronModule,
  ],
})
export class HttpLogCronAppModule {
  private readonly logger = new Logger(HttpLogCronAppModule.name);

  constructor() {
    this.logger.log('Крон HTTP-логов: загрузка из Redis в БД по расписанию');
  }
}
