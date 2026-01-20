import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SessionService } from './session.service';
import { SessionStorageService } from './session-storage.service';
import { RedisSessionStorageService } from './redis-session-storage.service';
import { HttpModule } from '../http/http.module';
import { RedisModule } from '../redis/redis.module';
import { ISessionStorage } from './session.interface';
import { RedisService } from '../redis/redis.service';
import { ConfigService } from '@nestjs/config';

/**
 * Фабрика для выбора хранилища сессии (Redis или файл)
 */
const sessionStorageFactory = (
  redisService: RedisService,
  redisSessionStorage: RedisSessionStorageService,
  fileSessionStorage: SessionStorageService,
  configService: ConfigService,
): ISessionStorage => {
  // Проверяем, включено ли кэширование сессий в Redis
  const enableRedisSessionCache = configService.get<boolean>('ENABLE_REDIS_SESSION_CACHE', true);
  
  // Если кэширование включено и Redis доступен, используем его, иначе файловое хранилище
  if (enableRedisSessionCache && redisService.isRedisAvailable()) {
    return redisSessionStorage;
  }
  return fileSessionStorage;
};

@Global()
@Module({
  imports: [HttpModule, RedisModule],
  providers: [
    SessionService,
    SessionStorageService,
    RedisSessionStorageService,
    {
      provide: 'ISessionStorage',
      useFactory: sessionStorageFactory,
      inject: [RedisService, RedisSessionStorageService, SessionStorageService, ConfigService],
    },
  ],
  exports: [SessionService, 'ISessionStorage'],
})
export class SessionModule {}


